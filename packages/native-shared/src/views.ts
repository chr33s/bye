import { MAIL_VIEWS, type MailView } from "@bye/domain";

// The one list of navigable mail views for every client (web, native, deep links, CLI/TUI).
// The names come from @bye/domain (the same literals the MailViewName contract uses, minus the
// parameterised `label` view); presentation — labels, short tab labels, keyboard shortcuts — lives
// here once instead of in each client.

export { MAIL_VIEWS, type MailView };

export const isMailView = (value: string | undefined): value is MailView =>
  value !== undefined && (MAIL_VIEWS as ReadonlyArray<string>).includes(value);

export interface MailViewNav {
  readonly view: MailView;
  readonly label: string;
  /** Compact label for native tab bars. */
  readonly short: string;
  /** Web single-key shortcut, when the view has one. */
  readonly key?: string;
}

/** Views shown in navigation, in display order ("everything" is reachable but not listed). */
export const MAIL_VIEW_NAV: ReadonlyArray<MailViewNav> = [
  { view: "imbox", label: "Inbox", short: "Inbox", key: "i" },
  { view: "feed", label: "Newsletters", short: "News", key: "f" },
  { view: "paper-trail", label: "Receipts", short: "Receipts", key: "p" },
  { view: "screener", label: "New Senders", short: "New", key: "s" },
  { view: "reply-later", label: "Reply Later", short: "Later", key: "l" },
  { view: "set-aside", label: "Set Aside", short: "Aside", key: "a" },
  { view: "bubble-up", label: "Follow Up", short: "Follow Up", key: "b" },
  { view: "spam", label: "Spam", short: "Spam" },
  { view: "screened-out", label: "Screened Out", short: "Screened Out" },
  { view: "trash", label: "Trash", short: "Trash", key: "t" },
];

export const mailViewLabel = (view: string): string | undefined =>
  MAIL_VIEW_NAV.find((n) => n.view === view)?.label ??
  (view === "everything" ? "Everything" : undefined);

/** Avatar palette (brand accents on ink); the tone is stable per sender so a row keeps its colour. */
export const AVATAR_TONES: ReadonlyArray<{ readonly bg: string; readonly fg: string }> = [
  { bg: "#2f5d50", fg: "#f6f1e7" },
  { bg: "#d5613f", fg: "#1d1b16" },
  { bg: "#f2c94c", fg: "#1d1b16" },
  { bg: "#4a5fd0", fg: "#f6f1e7" },
  { bg: "#e8a0bf", fg: "#1d1b16" },
];

/** "Sunny Vacations <a@b>" → "SV"; falls back to the address' first letter. */
export const senderInitials = (sender: string): string => {
  const name = sender.replace(/<[^>]*>/, "").trim() || sender.replace(/[<>]/g, "");
  const words = name.split(/[\s@._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((w) => w[0]) : [words[0]?.[0] ?? "?"];

  return letters.join("").toUpperCase();
};

export const avatarToneIndex = (sender: string): number => {
  let n = 0;

  for (const ch of sender.toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) >>> 0;

  return n % AVATAR_TONES.length;
};

export const avatarTone = (sender: string): { readonly bg: string; readonly fg: string } =>
  AVATAR_TONES[avatarToneIndex(sender)]!;
