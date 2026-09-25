// Product parity ledger (§2). Every row is a release requirement; infra/tests/parity.test.ts
// fails when a row has no executable acceptance test tagged with its ID.

export interface ParityRow {
  readonly id: string;
  readonly capability: string;
  readonly stage: number;
}

export const PARITY_LEDGER: ReadonlyArray<ParityRow> = [
  { id: "E01", capability: "Screener", stage: 2 },
  { id: "E02", capability: "Sender and domain policies", stage: 2 },
  { id: "E03", capability: "Speakeasy", stage: 2 },
  { id: "E04", capability: "Imbox", stage: 2 },
  { id: "E05", capability: "Feed", stage: 2 },
  { id: "E06", capability: "Paper Trail", stage: 2 },
  { id: "E07", capability: "Reply Later / Focus & Reply", stage: 2 },
  { id: "E08", capability: "Set Aside", stage: 2 },
  { id: "E09", capability: "Bubble Up", stage: 2 },
  { id: "E10", capability: "Read Together / Power Through New", stage: 2 },
  { id: "E11", capability: "Thread controls", stage: 2 },
  { id: "E12", capability: "Bundles, labels, and automatic filing", stage: 2 },
  { id: "E13", capability: "Workflows", stage: 2 },
  { id: "E14", capability: "Collections", stage: 2 },
  { id: "E15", capability: "Notes and clips", stage: 2 },
  { id: "E16", capability: "Contacts", stage: 2 },
  { id: "E17", capability: "Composer", stage: 2 },
  { id: "E18", capability: "Sending controls", stage: 2 },
  { id: "E19", capability: "Identities and linked accounts", stage: 2 },
  { id: "E20", capability: "Attachments", stage: 2 },
  { id: "E21", capability: "Search", stage: 2 },
  { id: "E22", capability: "Away replies and forwarding", stage: 2 },
  { id: "E23", capability: "Privacy and notifications", stage: 2 },
  { id: "E24", capability: "Retention and presentation", stage: 2 },
  { id: "C01", capability: "Views and navigation", stage: 3 },
  { id: "C02", capability: "Events", stage: 3 },
  { id: "C03", capability: "Recurrence and time zones", stage: 3 },
  { id: "C04", capability: "Invitations", stage: 3 },
  { id: "C05", capability: "Calendar interoperability", stage: 3 },
  { id: "C06", capability: "Sometime this week", stage: 3 },
  { id: "C07", capability: "Habits and time tracking", stage: 3 },
  { id: "C08", capability: "Personal day context", stage: 3 },
  { id: "C09", capability: "Email integration", stage: 3 },
  { id: "C10", capability: "Search, location, and device surfaces", stage: 3 },
  { id: "O01", capability: "Custom domains", stage: 4 },
  { id: "O02", capability: "Team administration", stage: 4 },
  { id: "O03", capability: "Extensions/shared addresses", stage: 4 },
  { id: "O04", capability: "Shared threads and collections", stage: 4 },
  { id: "O05", capability: "Public thread links", stage: 4 },
  { id: "P01", capability: "World-style publishing", stage: 5 },
  { id: "P02", capability: "World subscriptions", stage: 5 },
  { id: "A01", capability: "Account types", stage: 5 },
  { id: "A02", capability: "Commercial lifecycle", stage: 5 },
  { id: "A03", capability: "Authentication and recovery", stage: 5 },
  { id: "A04", capability: "Portability and closure", stage: 5 },
  { id: "X01", capability: "Clients", stage: 6 },
  { id: "X02", capability: "CLI, TUI, and agents", stage: 6 },
];
