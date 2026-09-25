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

export const toSecureStoreError = (error: unknown): SecureStoreError => {
  if (error instanceof SecureStoreError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  const kind =
    typeof code === "string" &&
    ["MissingCredential", "StorageUnavailable", "StorageDenied", "CorruptCredential"].includes(code)
      ? (code as SecureStoreErrorKind)
      : "StorageUnavailable";
  const nativeCode =
    (error as { userInfo?: { nativeCode?: unknown }; nativeCode?: unknown } | null)?.nativeCode ??
    (error as { userInfo?: { nativeCode?: unknown } } | null)?.userInfo?.nativeCode;
  return new SecureStoreError(
    kind,
    typeof nativeCode === "string" || typeof nativeCode === "number"
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
      typeof s.refreshToken === "string" &&
      s.refreshToken.length >= 16 &&
      typeof s.savedAt === "number"
    ) {
      return {
        v: 1,
        refreshToken: s.refreshToken,
        scope: typeof s.scope === "string" ? s.scope : "",
        savedAt: s.savedAt,
        ...(s.pendingRevoke ? { pendingRevoke: true } : {}),
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
  read: (key) => module.read(key).catch((e: unknown) => Promise.reject(toSecureStoreError(e))),
  write: (key, value) =>
    module.write(key, value).catch((e: unknown) => Promise.reject(toSecureStoreError(e))),
  remove: (key) => module.remove(key).catch((e: unknown) => Promise.reject(toSecureStoreError(e))),
});
