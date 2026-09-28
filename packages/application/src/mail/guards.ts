import type { MailboxCommand, MailboxCommandTag } from "@bye/contracts";
import { Context, Effect } from "effect";
import {
  type CurrentAuthentication,
  requireStepUp,
  type StepUpRequired,
} from "../control/index.ts";
import { Directory } from "../control/policy.ts";
import {
  Forbidden,
  NotFound,
  type Principal,
  requireMailbox,
  type Unavailable,
} from "../services.ts";

// Per-command authorization beyond the scope table (§8, §10, §11): step-up for consequential
// changes, the second mailbox of a redelivery, rule redelivery targets, and send-as authority for
// hosted identities. One table, checked by `executeMailboxCommand` before the command runs.

/** Facts about a source delivery that redelivery guards need (quarantine, scan verdict). */
export class MailboxFacts extends Context.Service<
  MailboxFacts,
  {
    readonly redeliverySource: (
      mailboxId: string,
      deliveryId: string,
    ) => Effect.Effect<
      {
        readonly quarantined: boolean;
        readonly scan: { readonly allowed: boolean; readonly status: string };
      } | null,
      Unavailable
    >;
  }
>()("mail/MailboxFacts") {}

/** What guards may fail with and require (all request-scoped services). */
export type GuardFailure = Forbidden | NotFound | StepUpRequired | Unavailable;

export type GuardServices = CurrentAuthentication | Principal | Directory | MailboxFacts;

type Guard<K extends MailboxCommandTag> = (
  mailboxId: string,
  command: Extract<MailboxCommand, { readonly _tag: K }>,
) => Effect.Effect<void, GuardFailure, GuardServices>;

type CommandGuardTable = { readonly [K in MailboxCommandTag]?: Guard<K> };

export const COMMAND_GUARDS: CommandGuardTable = {
  // New sending identities need a recent step-up; a hosted identity is auto-verified in the
  // mailbox, so the directory must confirm the principal may send as that address (E19).
  AddIdentity: (mailboxId, c) =>
    Effect.gen(function* () {
      yield* requireStepUp("new-identity");

      if (c.kind !== "hosted") return;
      const principal = yield* requireMailbox(mailboxId, "send");

      if (!(yield* (yield* Directory).canSendAs(principal.userId, mailboxId, c.address)))
        return yield* new Forbidden({ reason: "address not authorized for this mailbox" });
    }),
  AddForwardingDestination: () => Effect.asVoid(requireStepUp("forwarding")),
  PutForwardingRule: () => Effect.asVoid(requireStepUp("forwarding")),
  // Internal redelivery validates BOTH accounts (§11) and never launders quarantined or unscanned
  // mail. The source is authorized first, so the checks never reveal whether a delivery exists
  // in a mailbox the caller can't read.
  Redeliver: (mailboxId, c) =>
    Effect.gen(function* () {
      yield* requireMailbox(mailboxId, "read");
      yield* requireMailbox(c.targetMailboxId, "send");
      const source = yield* (yield* MailboxFacts).redeliverySource(mailboxId, c.deliveryId);

      if (!source) return yield* new NotFound({ resource: "delivery" });

      if (source.quarantined)
        return yield* new Forbidden({ reason: "quarantined messages cannot be redelivered" });

      if (!source.scan.allowed)
        return yield* new Forbidden({ reason: `message scan ${source.scan.status}` });
    }),
  // Rule-based redelivery targets must be mailboxes the principal may send into (E22).
  PutRule: (_mailboxId, c) =>
    c.actions.redeliverTo
      ? Effect.asVoid(requireMailbox(c.actions.redeliverTo, "send"))
      : Effect.void,
};

/** Run the command's guard, if it has one. */
export const guardMailboxCommand = (
  mailboxId: string,
  command: MailboxCommand,
): Effect.Effect<void, GuardFailure, GuardServices> => {
  const guard = COMMAND_GUARDS[command._tag] as Guard<MailboxCommandTag> | undefined;

  return guard ? guard(mailboxId, command) : Effect.void;
};
