import { Predicate } from "effect";

/** The runtime type name of a caught or foreign value, for aggregated failure logging. */
export const typeNameOf = <V>(value: V): string => {
  if (Predicate.isUndefined(value)) return "undefined";

  if (Predicate.isString(value)) return "string";

  if (Predicate.isNumber(value)) return "number";

  if (Predicate.isBoolean(value)) return "boolean";

  if (Predicate.isBigInt(value)) return "bigint";

  if (Predicate.isSymbol(value)) return "symbol";

  if (Predicate.isFunction(value)) return "function";

  return "object";
};
