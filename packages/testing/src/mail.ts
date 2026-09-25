import type { SafetyVerdict } from "@bye/domain";
import type { MessageSummary } from "@bye/mail-codec";
import {
  basicMailboxCodec,
  type MailboxDeliveryInput,
  MailboxStore,
  SearchShard,
  type TransactionalStorage,
} from "@bye/platform-cloudflare";
import { TestClock } from "./clock.ts";
import { MemoryDurableStorage } from "./sqlite.ts";

/** Open (or reopen, e.g. after an eviction) a mailbox authority over `storage`. */
export const openTestMailbox = (
  storage: TransactionalStorage,
  mailboxId: string,
  clock: TestClock,
  publishAddress: string | null = null,
): MailboxStore =>
  new MailboxStore(storage, { mailboxId, clock, codec: basicMailboxCodec, publishAddress });

/** A mailbox authority over in-memory SQLite with a deterministic clock. */
export const makeTestMailbox = (mailboxId = "mbx_test0000000000000000000") => {
  const storage = new MemoryDurableStorage();
  const clock = new TestClock();
  const store = openTestMailbox(storage, mailboxId, clock);
  const identityId = store.ctx.cmd("setup-identity", "AddIdentity", () =>
    store.identities.addIdentity({ address: "me@bye.test", name: "Me", kind: "hosted" }),
  );
  return { storage, clock, store, identityId, mailboxId };
};

export const makeTestSearchShard = () => new SearchShard(new MemoryDurableStorage());

let ingestCounter = 0;

export const summaryFixture = (
  overrides: Partial<MessageSummary> & { readonly fromAddress?: string } = {},
): MessageSummary => {
  const { fromAddress, ...rest } = overrides;
  return {
    from: { name: undefined, address: fromAddress ?? "alice@example.com" },
    to: [{ name: undefined, address: "me@bye.test" }],
    cc: [],
    replyTo: [],
    subject: "Hello",
    date: Date.UTC(2026, 8, 25, 11, 0, 0),
    messageIdHeader: `m${++ingestCounter}@example.com`,
    inReplyTo: [],
    references: [],
    listId: undefined,
    listUnsubscribe: undefined,
    automated: false,
    snippet: "hi there",
    attachments: [],
    hasCalendar: false,
    calendarMethod: undefined,
    ...rest,
  };
};

export const deliveryFixture = (
  clock: TestClock,
  summary: MessageSummary,
  overrides: Partial<MailboxDeliveryInput> & { readonly safety?: SafetyVerdict } = {},
): MailboxDeliveryInput => {
  const id = `ing_${(++ingestCounter).toString().padStart(20, "0")}`;
  return {
    ingestionId: id,
    recipient: "me@bye.test",
    messageKey: `t/mbx/orig/${id}.eml`,
    rawSize: 2048,
    summary,
    safety: { _tag: "Clean" },
    receivedAt: clock.now(),
    ...overrides,
  };
};

let commandCounter = 0;
/** Fresh command ID for each mutation in a test. */
export const cmd = (label = "c"): string => `${label}_${++commandCounter}`;
