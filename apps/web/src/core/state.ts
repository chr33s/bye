import type { CalendarCommandInput, MailboxCommandInput } from "@bye/native-shared";
import { ApiRequestError, client, type Me } from "../api.ts";
import { stepUpWithPasskey } from "../auth.ts";

// Session-scoped client state and command helpers shared by every view.

interface SessionState {
  me: Me | null;
  mailboxId: string | null;
  calendarId: string | null;
}

export const state: SessionState = {
  me: null,
  mailboxId: null,
  calendarId: null,
};

export const mb = (): string => {
  if (!state.mailboxId) throw new Error("No mailbox on this account");

  return state.mailboxId;
};

export const cal = (): string => {
  if (!state.calendarId) throw new Error("No calendar on this account");

  return state.calendarId;
};

/** Typed mailbox command (contracts) against the selected mailbox; the client adds the command ID. */
export const mailCommand = <T = unknown>(command: MailboxCommandInput): Promise<T> =>
  client.command<T>(mb(), command);

/** Typed calendar command (contracts) against the selected calendar space. */
export const calendarCommand = <T = unknown>(command: CalendarCommandInput): Promise<T> =>
  client.calendarCommand<T>(cal(), command);

/**
 * Consequential actions (new identities, forwarding, credentials, sharing, admin) require a recent
 * passkey step-up (§10). On a 403 the user confirms with their passkey and the action is retried once.
 */
export const withStepUp = async <T>(
  fn: () => Promise<T>,
  ceremony: () => Promise<void> = stepUpWithPasskey,
): Promise<T> => {
  try {
    return await fn();
  } catch (error) {
    // Only a step-up refusal is retried after a passkey ceremony; other 403s are real refusals.
    if (
      !(
        error instanceof ApiRequestError &&
        error.status === 403 &&
        error.details?.["stepUp"] === true
      )
    )
      throw error;
    await ceremony();

    return fn();
  }
};

export const zone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Per-viewer UI conveniences only; failures are ignored (private mode, blocked storage). */
export const remember = {
  get: (key: string): string | null => {
    try {
      return localStorage.getItem(`bye:${key}`);
    } catch {
      return null;
    }
  },
  set: (key: string, value: string): void => {
    try {
      localStorage.setItem(`bye:${key}`, value);
    } catch {
      // ignore
    }
  },
};
