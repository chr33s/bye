import { encodeId, type IdKind } from "@bye/domain";

/** Clock and ID source for kernel-backed stores; IDs are typed by prefix (unknown → EventId). */
export const kernelClock = {
  now: () => Date.now(),
  id: (prefix: string) =>
    encodeId(
      ID_KIND_BY_PREFIX.get(prefix) ?? "EventId",
      crypto.getRandomValues(new Uint8Array(16)),
    ),
};

const ID_KIND_BY_PREFIX = new Map<string, IdKind>([
  ["usr", "UserId"],
  ["org", "OrganizationId"],
  ["mbx", "MailboxId"],
  ["cal", "CalendarId"],
  ["spc", "SpaceId"],
  ["thr", "ThreadId"],
  ["dlv", "DeliveryId"],
  ["msg", "MessageId"],
  ["drf", "DraftId"],
  ["snd", "SendJobId"],
  ["ing", "IngestionId"],
  ["idn", "IdentityId"],
  ["cmd", "CommandId"],
  ["evt", "EventId"],
]);
