import { Predicate, Schema, SchemaTransformation } from "effect";

/**
 * A value an authority (Durable Object) returned untyped over RPC, answered exactly as it always
 * was (`JSON.stringify`: `undefined` members are omitted). Unlike `Schema.Unknown`, whose JSON codec
 * refuses anything that isn't already strict JSON, it is never validated or rewritten: command
 * results replay from stored receipts, and reads carry stored JSON, so a narrower schema would drop
 * or refuse real keys.
 */
export const AuthorityValue = Schema.declare(Predicate.isUnknown, {
  expected: "an authority value",
  toCodecJson: () => Schema.link<unknown>()(Schema.Any, SchemaTransformation.passthrough()),
});

export type AuthorityValue = typeof AuthorityValue.Type;
