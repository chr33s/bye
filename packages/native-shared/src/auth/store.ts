import { Predicate } from "effect";
import { normalizeOrigin } from "./url.ts";

// OS secure storage for the desktop refresh credential (macOS Keychain, Windows Credential Manager).
// There is deliberately no AsyncStorage/plaintext implementation: a storage failure is surfaced,
// never downgraded (spec DS05).

export type SecureStoreErrorKind =
  | "MissingCredential"
  | "StorageUnavailable"
  | "StorageDenied"
  | "CorruptCredential";

export class SecureStoreError extends Error {
  override readonly name = "SecureStoreError";
  constructor(
    readonly kind: SecureStoreErrorKind,
    /** Sanitized native status (e.g. OSStatus, Win32 error). Never contains the secret. */
    readonly nativeCode?: string,
  ) {
    super(`secure storage: ${kind}${nativeCode ? ` (${nativeCode})` : ""}`);
  }
}

/** Raw secret storage provided by the host (native module). Keys are opaque, namespaced strings. */
export interface SecureSessionStore {
  /** Rejects with SecureStoreError; MissingCredential when nothing is stored. */
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  /** Idempotent: removing a missing entry succeeds. */
  remove(key: string): Promise<void>;
}

export interface StoredSession {
  readonly v: 1;
  readonly refreshToken: string;
  readonly scope: string;
  readonly savedAt: number;
  /** Set when logout could not reach the server; revocation is retried on next launch. */
  readonly pendingRevoke?: boolean;
}

/**
 * One credential slot per validated instance (normalized base URL + issuer). Another server claiming
 * the same name, account or issuer gets a different key and never reads this slot.
 */
export const sessionKey = (instanceKey: string): string => {
  if (!/^https:\/\/[^|\s]+\|https:\/\/[^|\s]+$/.test(instanceKey))
    throw new Error("invalid instance key");

  return `email.bye.session.v2|${instanceKey}`;
};

/** Pre-instance builds kept one slot per API origin; read once to migrate the hosted session. */
export const legacySessionKey = (origin: string): string =>
  `email.bye.desktop.session.v1|${normalizeOrigin(origin)}`;

const SECURE_STORE_ERROR_KINDS: ReadonlyArray<string> = [
  "MissingCredential",
  "StorageUnavailable",
  "StorageDenied",
  "CorruptCredential",
];

export const toSecureStoreError = (cause: unknown): SecureStoreError => {
  if (cause instanceof SecureStoreError) return cause;
  const object = Predicate.isObjectKeyword(cause) ? cause : null;
  const code = object !== null && "code" in object ? object.code : undefined;
  const direct = object !== null && "nativeCode" in object ? object.nativeCode : undefined;
  const info = object !== null && "userInfo" in object ? object.userInfo : undefined;

  const nested =
    Predicate.isObjectKeyword(info) && "nativeCode" in info ? info.nativeCode : undefined;

  const nativeCode = direct ?? nested;

  const kind =
    Predicate.isString(code) && SECURE_STORE_ERROR_KINDS.includes(code)
      ? (code as SecureStoreErrorKind)
      : "StorageUnavailable";

  return new SecureStoreError(
    kind,
    Predicate.isString(nativeCode) || Predicate.isNumber(nativeCode)
      ? String(nativeCode)
      : undefined,
  );
};

export const encodeSession = (s: StoredSession): string => JSON.stringify(s);

export const decodeSession = (raw: string): StoredSession => {
  try {
    const s = JSON.parse(raw) as Partial<StoredSession>;

    if (
      s.v === 1 &&
      Predicate.isString(s.refreshToken) &&
      s.refreshToken.length >= 16 &&
      Predicate.isNumber(s.savedAt)
    ) {
      const pending: PendingRevokeFields = {};

      if (s.pendingRevoke) pending.pendingRevoke = true;

      return {
        v: 1,
        refreshToken: s.refreshToken,
        scope: Predicate.isString(s.scope) ? s.scope : "",
        savedAt: s.savedAt,
        ...pending,
      };
    }
  } catch {
    // fall through
  }

  throw new SecureStoreError("CorruptCredential");
};

/** Wrap a host module whose methods reject with `{ code: SecureStoreErrorKind }`. */
export const nativeSecureStore = (module: {
  read(key: string): Promise<string>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}): SecureSessionStore => ({
  read: (key) =>
    module.read(key).catch((cause: unknown) => Promise.reject(toSecureStoreError(cause))),
  write: (key, value) =>
    module.write(key, value).catch((cause: unknown) => Promise.reject(toSecureStoreError(cause))),
  remove: (key) =>
    module.remove(key).catch((cause: unknown) => Promise.reject(toSecureStoreError(cause))),
});

interface PendingRevokeFields {
  pendingRevoke?: true;
}
