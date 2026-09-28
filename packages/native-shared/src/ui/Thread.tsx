import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, Text, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import { toLocalDate, ymd } from "../calendar-form.ts";
import type { ByeClient } from "../client.ts";
import {
  firstCalendarId,
  fromMessagePayload,
  findThreadInvitations,
  PARTSTAT_LABEL,
  type Partstat,
  RSVP_CHOICES,
  type ThreadInvitation,
} from "../mail-calendar.ts";
import type { DeliveryWire, ThreadDetailWire } from "../wire.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

const SCAN_NOTICE: Readonly<Record<string, string>> = {
  pending: "Scanning attachments…",
  infected: "Attachments blocked: a threat was detected.",
  failed: "Attachments blocked: they couldn't be scanned.",
};

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Thread view. Message HTML is never rendered natively or with app credentials: each message is a
 * sandboxed WebView pointed at its short-lived render URL on the separate MAIL_ORIGIN (§10), with
 * JavaScript, storage and cookies off. Any navigation away opens in the system browser.
 */
export const Thread = ({
  client,
  mailboxId,
  calendarId,
  threadId,
  onReply,
  onDone,
}: {
  client: ByeClient;
  mailboxId: string;
  /** The account's calendar space; invitation and create-event actions need one (C09). */
  calendarId?: string;
  threadId: string;
  onReply: () => void;
  onDone?: () => void;
}) => {
  const [detail, setDetail] = useState<ThreadDetailWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    client
      .thread(mailboxId, threadId)
      .then(async (d) => {
        if (!live) return;
        setDetail(d);
        await client.markSeen(mailboxId, threadId, d.thread.revision);
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [client, mailboxId, threadId]);

  const act = useCallback(
    (label: string, fn: () => Promise<unknown>, leave = false) =>
      () => {
        setStatus(`${label}…`);
        void fn().then(
          () => {
            setStatus(label);
            if (leave) onDone?.();
          },
          (e: unknown) =>
            setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      },
    [onDone],
  );

  if (error) return <Text style={[s.error, s.pad]}>{error}</Text>;
  if (!detail) return <ActivityIndicator style={{ margin: 32 }} />;
  const attention =
    (detail.thread as { attention?: { replyLater?: boolean; setAside?: boolean } }).attention ?? {};
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1} accessibilityRole="header">
        {detail.thread.subject || "(no subject)"}
      </Text>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}
        accessibilityLabel="Thread actions"
      >
        <Button label="Reply" primary onPress={onReply} />
        <Button
          label={attention.replyLater ? "Remove from Reply Later" : "Reply Later"}
          onPress={act("Reply Later updated", () =>
            client.attention(mailboxId, threadId, "replyLater", !attention.replyLater),
          )}
        />
        <Button
          label={attention.setAside ? "Done with it" : "Set Aside"}
          onPress={act("Set Aside updated", () =>
            client.attention(mailboxId, threadId, "setAside", !attention.setAside),
          )}
        />
        <Button
          label="Follow up tomorrow"
          onPress={act("Will follow up tomorrow", () =>
            client.bubbleUp(mailboxId, threadId, tomorrow.getTime()),
          )}
        />
        <Button
          label="Follow up tomorrow if no reply"
          onPress={act("Will follow up tomorrow unless someone replies", () =>
            client.bubbleUp(mailboxId, threadId, tomorrow.getTime(), "if-no-reply"),
          )}
        />
        <Button
          label="Trash"
          onPress={act("Moved to Trash", () => client.trash(mailboxId, [threadId]), true)}
        />
        <Button
          label="Spam"
          onPress={act("Marked as spam", () => client.spam(mailboxId, [threadId]), true)}
        />
      </View>
      {status ? (
        <Text style={s.muted} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
      {detail.deliveries.map((d) => (
        <View key={d.deliveryId} style={{ marginBottom: 16 }}>
          <Text style={s.text}>{d.from.name || d.from.address}</Text>
          <Text style={s.muted}>{new Date(d.date).toLocaleString()}</Text>
          {calendarId && d.routing?.hasCalendar ? (
            <Invitation
              client={client}
              calendarId={calendarId}
              mailboxId={mailboxId}
              deliveryId={d.deliveryId}
              subject={detail.thread.subject}
            />
          ) : null}
          <SandboxedMessage url={d.renderUrl} title={`Message from ${d.from.address}`} />
          <Attachments delivery={d} client={client} mailboxId={mailboxId} />
          {calendarId ? (
            <CreateEventFromMessage
              client={client}
              calendarId={calendarId}
              mailboxId={mailboxId}
              threadId={threadId}
              deliveryId={d.deliveryId}
              subject={detail.thread.subject}
            />
          ) : null}
        </View>
      ))}
    </ScrollView>
  );
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Invitation actions (C09), as on the web: find the invitation's event in the calendar and reply
 * with Accept / Maybe / Decline. The server updates the attendee copy and sends the iTIP REPLY.
 */
const rowKey = (e: ThreadInvitation) => `${e.eventId}:${e.occurrenceKey ?? ""}`;

const Invitation = ({
  client,
  calendarId,
  mailboxId,
  deliveryId,
  subject,
}: {
  client: ByeClient;
  calendarId: string;
  mailboxId: string;
  deliveryId: string;
  subject: string;
}) => {
  const [events, setEvents] = useState<ReadonlyArray<ThreadInvitation> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Readonly<Record<string, string>>>({});

  useEffect(() => {
    let live = true;
    findThreadInvitations(client, calendarId, mailboxId, deliveryId, subject).then(
      (found) => {
        if (!live) return;
        setEvents(found);
        setStatus(
          Object.fromEntries(
            found.flatMap((e) =>
              e.cancelled
                ? [[rowKey(e), "Cancelled by the organizer"]]
                : e.answer
                  ? [[rowKey(e), e.answer]]
                  : [],
            ),
          ),
        );
      },
      () => live && setError("Calendar unavailable."),
    );
    return () => {
      live = false;
    };
  }, [client, calendarId, mailboxId, deliveryId, subject]);

  const respond = (e: ThreadInvitation, partstat: Partstat, label: string) => () => {
    const key = rowKey(e);
    setStatus((m) => ({ ...m, [key]: `${label}…` }));
    void client
      .respondInvitation(calendarId, e.eventId, partstat, e.occurrenceKey ?? undefined)
      .then(
        () => setStatus((m) => ({ ...m, [key]: PARTSTAT_LABEL[partstat] ?? label })),
        (err: unknown) => setStatus((m) => ({ ...m, [key]: `${label} failed: ${errorText(err)}` })),
      );
  };

  return (
    <View style={{ marginTop: 8 }} accessibilityLabel="Invitation">
      <Text style={s.text}>This message contains a calendar invitation.</Text>
      {error ? (
        <Text style={s.muted} accessibilityRole="alert">
          {error}
        </Text>
      ) : events === null ? (
        <ActivityIndicator accessibilityLabel="Looking for the event" style={{ margin: 8 }} />
      ) : events.length === 0 ? (
        <Text style={s.muted}>The event hasn't reached your calendar yet.</Text>
      ) : (
        events.map((e) => (
          <View key={rowKey(e)} style={{ marginTop: 8 }}>
            <Text style={s.text}>{e.label}</Text>
            {e.cancelled ? null : (
              <View
                style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 4 }}
                accessibilityLabel={`Respond to ${e.label}`}
              >
                {RSVP_CHOICES.map(([partstat, label]) => (
                  <Button key={partstat} label={label} onPress={respond(e, partstat, label)} />
                ))}
              </View>
            )}
            {status[rowKey(e)] ? (
              <Text style={s.muted} accessibilityLiveRegion="polite">
                {status[rowKey(e)]}
              </Text>
            ) : null}
          </View>
        ))
      )}
    </View>
  );
};

const nextHour = (offsetHours: number) => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1 + offsetHours);
  return `${ymd(toLocalDate(d))}T${String(d.getHours()).padStart(2, "0")}:00`;
};

/**
 * Create an event from this message (C09). The event keeps a backlink to the message; the server
 * checks read access to the mailbox first, and only the calendar owner sees the link.
 */
const CreateEventFromMessage = ({
  client,
  calendarId,
  mailboxId,
  threadId,
  deliveryId,
  subject,
}: {
  client: ByeClient;
  calendarId: string;
  mailboxId: string;
  threadId: string;
  deliveryId: string;
  subject: string;
}) => {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(subject);
  const [start, setStart] = useState(() => nextHour(0));
  const [end, setEnd] = useState(() => nextHour(1));
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setErrors([]);
    setSaving(true);
    setStatus("Creating event…");
    try {
      const target = firstCalendarId((await client.calendars(calendarId)).items);
      if (!target) throw new Error("Create a calendar first");
      const built = fromMessagePayload({
        calendarId: target,
        mailboxId,
        threadId,
        deliveryId,
        title,
        start,
        end,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      if (!built.ok) {
        setErrors(built.errors);
        setStatus("");
        return;
      }
      await client.createEventFromMessage(calendarId, built.body);
      setStatus("Event created");
      setOpen(false);
    } catch (e) {
      setErrors([errorText(e)]);
      setStatus("");
    } finally {
      setSaving(false);
    }
  };

  const input = (label: string, value: string, onChange: (v: string) => void) => (
    <View style={{ marginBottom: 8 }}>
      <Text style={s.muted}>{label}</Text>
      <TextInput style={s.input} accessibilityLabel={label} value={value} onChangeText={onChange} />
    </View>
  );

  return (
    <View style={{ marginTop: 8 }}>
      <Button
        label="Create event from this message"
        hint={open ? "Hides the event form" : "Shows the event form"}
        onPress={() => setOpen((v) => !v)}
      />
      {open ? (
        <View style={{ marginTop: 8 }} accessibilityLabel="Create event from this message">
          {errors.length ? (
            <View accessibilityLiveRegion="assertive">
              {errors.map((e) => (
                <Text key={e} style={s.error}>
                  {e}
                </Text>
              ))}
            </View>
          ) : null}
          {input("Title", title, setTitle)}
          {input("Starts (YYYY-MM-DDTHH:mm)", start, setStart)}
          {input("Ends (YYYY-MM-DDTHH:mm)", end, setEnd)}
          <Button
            label={saving ? "Creating…" : "Create event"}
            primary
            disabled={saving}
            onPress={() => void save()}
          />
        </View>
      ) : null}
      {status ? (
        <Text style={s.muted} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
    </View>
  );
};

/** Attachment list with scan state (E20); downloads are offered only after a clean scan. */
const Attachments = ({
  delivery,
  client,
  mailboxId,
}: {
  delivery: DeliveryWire;
  client: ByeClient;
  mailboxId: string;
}) => {
  const [error, setError] = useState<string | null>(null);
  const files = delivery.attachments ?? [];
  if (files.length === 0) return null;
  const notice = SCAN_NOTICE[delivery.scan?.status ?? ""];
  // The OS opens a short-lived signed link on the render origin; scan status is re-checked on use.
  const open = (partId: string) => async () => {
    setError(null);
    try {
      const { downloadUrl } = await client.attachmentLink(mailboxId, delivery.deliveryId, partId);
      await Linking.openURL(downloadUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };
  return (
    <View style={{ marginTop: 8 }} accessibilityLabel="Attachments">
      {notice ? <Text style={s.muted}>{notice}</Text> : null}
      {files.map((f) =>
        notice ? (
          <Text key={f.partId} style={s.muted}>{`📎 ${f.filename} (${size(f.size)})`}</Text>
        ) : (
          <Button
            key={f.partId}
            label={`📎 ${f.filename} (${size(f.size)})`}
            onPress={open(f.partId)}
          />
        ),
      )}
      {error ? (
        <Text style={s.muted} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
};

export const SandboxedMessage = ({ url, title }: { url: string; title: string }) => {
  const origin = new URL(url).origin;
  return (
    <WebView
      accessibilityLabel={title}
      style={{ height: 420, marginTop: 8, borderRadius: 8 }}
      source={{ uri: url }}
      originWhitelist={[origin]}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      incognito
      cacheEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      mixedContentMode="never"
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === url) return true;
        if (/^https?:\/\//.test(request.url) || request.url.startsWith("mailto:"))
          void Linking.openURL(request.url);
        return false;
      }}
    />
  );
};
