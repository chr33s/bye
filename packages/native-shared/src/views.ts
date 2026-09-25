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
  { view: "imbox", label: "Imbox", short: "Imbox", key: "i" },
  { view: "feed", label: "The Feed", short: "Feed", key: "f" },
  { view: "paper-trail", label: "Paper Trail", short: "Paper Trail", key: "p" },
  { view: "screener", label: "Screener", short: "Screener", key: "s" },
  { view: "reply-later", label: "Reply Later", short: "Later", key: "l" },
  { view: "set-aside", label: "Set Aside", short: "Aside", key: "a" },
  { view: "bubble-up", label: "Bubble Up", short: "Bubble Up", key: "b" },
  { view: "spam", label: "Spam", short: "Spam" },
  { view: "screened-out", label: "Screened Out", short: "Screened Out" },
  { view: "trash", label: "Trash", short: "Trash", key: "t" },
];

export const mailViewLabel = (view: string): string | undefined =>
  MAIL_VIEW_NAV.find((n) => n.view === view)?.label ??
  (view === "everything" ? "Everything" : undefined);
