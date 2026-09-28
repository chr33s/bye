import { parseMessage } from "@bye/mail-codec";
import { scanStoredObject } from "../scan.ts";
import { Effect, Layer, Match, Predicate, Schema } from "effect";
import { calendarRefreshSubscription } from "@bye/application";
import { CALENDAR_DEEP_LINKS, CALENDAR_PHOTO_KEY, CalLocalDateSchema } from "@bye/contracts";
import { calendarFeedFetcherLive, calendarResolvingFetch } from "@bye/platform-cloudflare";
import { deliverNotification } from "../push.ts";
import { calendarRepositoryLayer } from "../services.ts";
import { ownerOfMailbox, type TopicHandlers } from "./types.ts";
import { calendar as calendarAuthority, mailbox } from "../authorities.ts";

// Calendar topics: inbound invitations, outbound iTIP, reminders.
export const calendarTopics: TopicHandlers<
  | "calendar.photo-scan"
  | "calendar.invitation"
  | "calendar.itip"
  | "calendar.notify"
  | "calendar.subscription.refresh"
  | "calendar.grant"
> = {
  /**
   * Day photos (C08) go through the same isolated ClamAV scanner as mail uploads. Clean photos are
   * marked `scan: clean` (the signed read route serves nothing else); infected or unscannable ones
   * are deleted and removed from the day, unless the owner has already replaced the photo.
   */
  "calendar.photo-scan": async ({ env, payload, attempt }) => {
    const { key, calendarId, ownerId } = payload;

    if (!CALENDAR_PHOTO_KEY.test(key) || !key.startsWith(`cal/${calendarId}/`)) return;
    const head = await env.PARTS.head(key);

    if (!head || head.customMetadata?.["scan"] === "clean") return; // already removed, or replayed after marking
    const result = await scanStoredObject(env, key, attempt);

    if (result.outcome === "clean") {
      // R2 metadata is immutable: rewrite the (≤10 MB) object with the verdict.
      const object = await env.PARTS.get(key);

      if (!object) return;
      await env.PARTS.put(key, await object.arrayBuffer(), {
        httpMetadata: object.httpMetadata ?? {},
        customMetadata: { ...object.customMetadata, scan: "clean" },
      });

      return;
    }

    await env.PARTS.delete(key);
    // Legacy photos may not know their day; a missing object then simply reads as not found.
    const date = Schema.decodeUnknownOption(CalLocalDateSchema)(payload.date);

    if (Predicate.isTagged(date, "Some")) {
      // Compare-and-set: clears the day only while it still shows this photo, so a replacement
      // uploaded meanwhile survives.
      await calendarAuthority(env, calendarId).execute(ownerId, {
        type: "SetDayDecoration",
        commandId: `photo-reject:${key}`,
        date: date.value,
        photoKey: null,
        expectedPhotoKey: key,
      });
    }

    console.warn(
      JSON.stringify({ level: "warn", op: "calendar.photo-scan", outcome: result.outcome }),
    );
  },
  "calendar.invitation": async ({ env, payload, mailboxId }) => {
    const owner = await ownerOfMailbox(env, mailboxId);

    if (!owner?.calendar_id) return;
    const original = await env.ORIGINALS.get(payload.messageKey);

    if (!original) throw new Error("invitation original missing");
    const parsed = parseMessage(new Uint8Array(await original.arrayBuffer()));

    if (!parsed.calendar) return;
    const delivery = await mailbox(env, mailboxId).delivery(payload.deliveryId);

    if (!delivery) return;
    const calendar = calendarAuthority(env, owner.calendar_id);
    await calendar.provision({
      ownerId: owner.user_id,
      selfAddresses: [owner.address],
      defaultZone: "UTC",
    });
    // Only approved deliveries emit this topic; screened-out mail never does (§9).
    await calendar.execute(null, {
      type: "ReceiveInvitation",
      commandId: payload.deliveryId,
      ics: parsed.calendar.ics,
      sender: parsed.from[0]?.address ?? "",
      sourceRef: { mailboxId, deliveryId: delivery.deliveryId, threadId: delivery.threadId },
    });

    return;
  },
  "calendar.itip": async ({ env, message: m, payload }) => {
    // Outbound iTIP REQUEST/REPLY/CANCEL goes through the owner's mailbox as system send jobs.
    const calendarId = m.source.replace(/^calendar:/, "");

    const owner = await env.DIRECTORY.withSession("first-primary")
      .prepare(
        "SELECT m.id AS mailbox_id, u.primary_address AS address FROM calendars c JOIN users u ON u.id = c.owner_user_id JOIN mailboxes m ON m.owner_user_id = u.id AND m.kind = 'personal' WHERE c.id = ? LIMIT 1",
      )
      .bind(calendarId)
      .first<{ mailbox_id: string; address: string }>();

    if (!owner) return;
    const { method } = payload;
    const summary = payload.summary || "Event";
    await mailbox(env, owner.mailbox_id).sendCalendarMessage({
      eventKey: m.eventId,
      method,
      ics: payload.ics,
      recipients: payload.recipients ?? [],
      from: payload.from ?? owner.address,
      subject: Match.value(method).pipe(
        Match.when("REPLY", () => `Reply: ${summary}`),
        Match.when("CANCEL", () => `Cancelled: ${summary}`),
        Match.orElse(() => `Invitation: ${summary}`),
      ),
    });

    return;
  },
  /** Reminders and invitation changes go to the notification boundary (C02/C10, E23). */
  "calendar.notify": async ({ env, message: m, payload }) => {
    const { kind } = payload;
    const eventId = payload.eventId ?? "";
    const title = payload.title || "Event";

    if (kind === "reminder") {
      const occurrenceKey = payload.occurrenceKey ?? "";
      const offset = payload.offsetMinutes ?? 0;
      await deliverNotification(env, {
        userId: m.target,
        kind: "calendar.reminder",
        title,
        body: offset > 0 ? `Starts in ${offset} minute${offset === 1 ? "" : "s"}` : "Starting now",
        url: CALENDAR_DEEP_LINKS.event(eventId, occurrenceKey),
        resource: eventId,
        dedupeKey: `reminder:${eventId}:${occurrenceKey}:${offset}`,
      });

      return;
    }

    if (kind.startsWith("invitation.")) {
      const action = kind.slice("invitation.".length);
      await deliverNotification(env, {
        userId: m.target,
        kind: "calendar.invitation",
        title,
        body: Match.value(action).pipe(
          Match.when("cancel", () => "Event cancelled"),
          Match.when("reply", () => "An attendee replied"),
          Match.when("update", () => "Invitation updated"),
          Match.orElse(() => "New invitation"),
        ),
        url: CALENDAR_DEEP_LINKS.event(eventId),
        resource: eventId,
        dedupeKey: `invitation:${m.eventId}`,
      });
    }
  },
  /** External read-only subscriptions (C05): fetch with SSRF checks, apply, and reschedule. */
  "calendar.subscription.refresh": async ({ env, message: m, payload }) => {
    const spaceId = m.source.replace(/^calendar:/, "");
    const calendarId = payload.calendarId ?? m.target;

    const layers = Layer.mergeAll(
      calendarRepositoryLayer(env),
      calendarFeedFetcherLive(calendarResolvingFetch((input, init) => fetch(input, init))),
    );

    const exit = await Effect.runPromiseExit(
      calendarRefreshSubscription(spaceId, calendarId, m.eventId).pipe(Effect.provide(layers)),
    );

    if (Predicate.isTagged(exit, "Failure")) {
      // A deleted subscription is not an error; anything else is logged without URLs or contents.
      console.warn(
        JSON.stringify({ level: "warn", op: "calendar.subscription.refresh", calendarId }),
      );
    }
  },
  /** Maintain the grantee discovery index in D1 (C05); the CalendarDO stays the authority. */
  "calendar.grant": async ({ env, message: m, payload }) => {
    const spaceId = m.source.replace(/^calendar:/, "");
    const { calendarId } = payload;
    const role = payload.role ?? null;

    if (role) {
      await env.DIRECTORY.prepare(
        `INSERT INTO calendar_grants (space_id, calendar_id, grantee_user_id, role, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (space_id, calendar_id, grantee_user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
      )
        .bind(spaceId, calendarId, m.target, role, Date.now())
        .run();
    } else {
      await env.DIRECTORY.prepare(
        "DELETE FROM calendar_grants WHERE space_id = ? AND calendar_id = ? AND grantee_user_id = ?",
      )
        .bind(spaceId, calendarId, m.target)
        .run();
    }
  },
};
