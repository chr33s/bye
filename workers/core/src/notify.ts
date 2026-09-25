import type { NotifyMessage } from "@bye/contracts";
import type { CoreEnv } from "./env.ts";
import { deliverNotification, mailboxAudience } from "./push.ts";
import { mailbox } from "./authorities.ts";

// `notify` queue consumer (§5.1 step 7, E23). The mailbox authority already applied the user's
// notification policy (quiet by default, opt-ins, quiet hours) before emitting; here we resolve the
// audience and content and hand off to push delivery. Mailbox-sourced events carry a mailbox ID in
// `userId` (outbox target); anything else is a user ID.

type ThreadResult =
  | { ok: true; value: { thread: { subject: string; sender: string } } }
  | { ok: false };

export const handleNotify = async (env: CoreEnv, m: NotifyMessage): Promise<void> => {
  const isMailbox = m.userId.startsWith("mbx_");
  const users = isMailbox ? await mailboxAudience(env, m.userId) : [m.userId];
  if (users.length === 0) return;
  let title = "bye";
  let body = "You have a new notification";
  let url = `${env.APP_ORIGIN}/#/`;
  if (isMailbox && m.kind === "delivery" && m.resource) {
    let thread: ThreadResult = { ok: false };
    try {
      // Forced by Cloudflare's RPC type mapping: `MailboxDO.thread`'s store type isn't expressible as
      // Serializable, so the stub's return collapses; the envelope is restated as `ThreadResult`.
      thread = (await mailbox(env, m.userId).thread(m.resource)) as unknown as ThreadResult;
    } catch {
      // fall back to a generic notification
    }
    title = thread.ok ? thread.value.thread.sender : "New mail";
    body = thread.ok ? thread.value.thread.subject || "(no subject)" : "You have new mail";
    url = `${env.APP_ORIGIN}/#/thread/${encodeURIComponent(m.resource)}`;
  } else if (m.kind === "forwarding-verification") {
    // Verification is sent by mail, not push (control/mail areas); nothing to notify here.
    return;
  } else if (m.kind) {
    title = m.kind.startsWith("invitation")
      ? "Calendar invitation"
      : m.kind === "reminder"
        ? "Reminder"
        : "bye";
    body = m.kind;
  }
  for (const userId of users) {
    await deliverNotification(env, {
      userId,
      kind: isMailbox ? `mail.${m.kind}` : m.kind,
      title,
      body,
      url,
      resource: m.resource || m.eventId,
      dedupeKey: `${m.eventId}:${userId}`,
    });
  }
};
