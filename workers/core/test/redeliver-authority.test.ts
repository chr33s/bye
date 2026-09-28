import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlAuth, ControlDirectory, type MailboxStore } from "@bye/platform-cloudflare";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { authConfig } from "../src/services.ts";
import {
  type Harness,
  inboundMessage,
  makeHarness,
  rfc822,
  executionContext,
  mockAs,
} from "./harness.ts";

// E19 regression: redelivery authority is re-checked when the transfer commits, so a stored
// redelivery rule stops injecting mail once its owner loses send access to the target.

(globalThis as { FixedLengthStream?: unknown }).FixedLengthStream = class extends TransformStream {
  constructor(_length: number) {
    super();
  }
};

const ctx = executionContext;

interface Account {
  readonly userId: string;
  readonly mailboxId: string;
  readonly address: string;
  readonly cookie: string;
}

const signup = async (h: Harness, address: string): Promise<Account> => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address, displayName: address.split("@")[0]! },
  );

  const auth = new ControlAuth(h.env.DIRECTORY, kernelClock, await authConfig(h.env));
  const session = await auth.issueSession(account.userId, "test", true);

  return { ...account, address, cookie: `__Host-session=${session.token}` };
};

const api = async <BodyValue>(
  h: Harness,
  a: Account,
  method: string,
  path: string,
  body?: BodyValue,
) => {
  const requestHeaders = new Headers({ cookie: a.cookie });

  if (method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

  if (method !== "GET") requestHeaders.set("content-type", "application/json");

  const response = await handleFetch(
    new Request(
      `${h.env.APP_ORIGIN}${path}`,
      body !== undefined
        ? { method, headers: requestHeaders, body: JSON.stringify(body) }
        : { method, headers: requestHeaders },
    ),
    h.env,
    ctx,
  );

  const text = await response.text();

  return { status: response.status, text, body: text ? JSON.parse(text) : null };
};

let n = 0;

const cmdId = () => `cmd_${(++n).toString(36).padStart(20, "0")}`;

const storeOf = (h: Harness, mailboxId: string) =>
  mockAs<{ store: MailboxStore }>(h.namespaces.MAILBOXES.instance(mailboxId)).store;

describe("redelivery authority at commit (E19)", () => {
  let h: Harness;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 25, 12));
    h = makeHarness();
  });
  afterEach(() => vi.useRealTimers());

  const deliverAndRedeliver = async (from: Account, to: Account, subject: string) => {
    const sender = "sender@example.net";
    await handleInbound(
      inboundMessage(
        sender,
        from.address,
        rfc822({ from: sender, to: from.address, subject, body: "b", messageId: `${++n}@x.test` }),
      ),
      h.env,
    );
    await h.drain();
    const store = storeOf(h, from.mailboxId);

    const deliveryId = store.ctx.sql.one<{ delivery_id: string }>(
      "SELECT delivery_id FROM deliveries ORDER BY received_at DESC, rowid DESC LIMIT 1",
    )!.delivery_id;

    store.transfers.redeliver({
      deliveryId,
      targetMailboxId: to.mailboxId,
      mode: "copy",
      summary: store.ingest.deliverySummary(deliveryId),
    });
    await h.namespaces.MAILBOXES.instance(from.mailboxId).alarm?.();
    await h.drain();

    return (await api(h, to, "GET", `/v1/mailboxes/${to.mailboxId}/views/everything`)).text;
  };

  it("commits only while the source's user still has active send access to the target", async () => {
    const ana = await signup(h, "ana@bye.test");
    const bob = await signup(h, "bob@bye.test");
    await api(h, ana, "POST", `/v1/mailboxes/${ana.mailboxId}/commands`, {
      _tag: "SetPolicy",
      commandId: cmdId(),
      kind: "domain",
      subject: "example.net",
      policy: {
        decision: "allowed",
        destination: "imbox",
        labels: [],
        bundle: false,
        notify: false,
      },
    });

    // No grant on the target: dropped.
    expect(await deliverAndRedeliver(ana, bob, "Never granted")).not.toContain("Never granted");

    // Ana joins Bob's org with send access to Bob's mailbox: committed.
    const org = (await h.d1
      .prepare("SELECT org_id FROM mailboxes WHERE id = ?")
      .bind(bob.mailboxId)
      .first<{ org_id: string }>())!.org_id;

    await h.d1
      .prepare(
        "INSERT INTO memberships (org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)",
      )
      .bind(org, ana.userId, Date.now(), Date.now())
      .run();
    await h.d1
      .prepare(
        "INSERT INTO mailbox_access (mailbox_id, user_id, role, can_send, created_at) VALUES (?, ?, 'member', 1, ?)",
      )
      .bind(bob.mailboxId, ana.userId, Date.now())
      .run();
    expect(await deliverAndRedeliver(ana, bob, "While member")).toContain("While member");

    // Suspended in the target's org: dropped.
    await h.d1
      .prepare("UPDATE memberships SET status = 'suspended' WHERE org_id = ? AND user_id = ?")
      .bind(org, ana.userId)
      .run();
    expect(await deliverAndRedeliver(ana, bob, "After suspension")).not.toContain(
      "After suspension",
    );

    // Active again but without send rights: dropped.
    await h.d1
      .prepare("UPDATE memberships SET status = 'active' WHERE org_id = ? AND user_id = ?")
      .bind(org, ana.userId)
      .run();
    await h.d1
      .prepare("UPDATE mailbox_access SET can_send = 0 WHERE mailbox_id = ? AND user_id = ?")
      .bind(bob.mailboxId, ana.userId)
      .run();
    expect(await deliverAndRedeliver(ana, bob, "Read only")).not.toContain("Read only");
  });
});
