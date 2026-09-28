// Opaque, tenant-scoped identifiers (§4.1). RFC Message-ID is never one of these.
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type UserId = Brand<string, "UserId">;

export type OrganizationId = Brand<string, "OrganizationId">;

export type MailboxId = Brand<string, "MailboxId">;

export type CalendarId = Brand<string, "CalendarId">;

export type SpaceId = Brand<string, "SpaceId">;

export type ThreadId = Brand<string, "ThreadId">;

export type DeliveryId = Brand<string, "DeliveryId">;

export type MessageId = Brand<string, "MessageId">;

export type DraftId = Brand<string, "DraftId">;

export type SendJobId = Brand<string, "SendJobId">;

export type IngestionId = Brand<string, "IngestionId">;

export type IdentityId = Brand<string, "IdentityId">;

export type CommandId = Brand<string, "CommandId">;

export type EventId = Brand<string, "EventId">;

export const ID_PREFIXES = {
  UserId: "usr",
  OrganizationId: "org",
  MailboxId: "mbx",
  CalendarId: "cal",
  SpaceId: "spc",
  ThreadId: "thr",
  DeliveryId: "dlv",
  MessageId: "msg",
  DraftId: "drf",
  SendJobId: "snd",
  IngestionId: "ing",
  IdentityId: "idn",
  CommandId: "cmd",
  EventId: "evt",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

const ID_PATTERN = /^[a-z]{3}_[0-9a-z]{20,40}$/;

export const isOpaqueId = (kind: IdKind, value: string): boolean =>
  ID_PATTERN.test(value) && value.startsWith(`${ID_PREFIXES[kind]}_`);

/** Encode random bytes into a lowercase base32 opaque identifier. */
export const encodeId = (kind: IdKind, random: Uint8Array): string => {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  let out = "";
  let bits = 0;
  let value = 0;

  for (const byte of random) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];

  return `${ID_PREFIXES[kind]}_${out}`;
};
