import { Predicate } from "effect";
import {
  type AuthorizationAttempt,
  createAuthorizationAttempt,
  DESKTOP_CLIENT_ID,
  parseCallback,
} from "./authorize.ts";
import type { RandomBytes } from "./pkce.ts";
import type { ValidatedInstance } from "../instance/discovery.ts";
import {
  decodeSession,
  encodeSession,
  legacySessionKey,
  SecureStoreError,
  type SecureStoreErrorKind,
  type SecureSessionStore,
  sessionKey,
  type StoredSession,
  toSecureStoreError,
} from "./store.ts";
import {
  OAuthError,
  RevocationUnsupported,
  type TokenFetch,
  TokenClient,
  type TokenSet,
  TransientAuthError,
} from "./tokens.ts";

// Native device session for desktop and mobile (A03/X01; spec §10 Desktop sign-in and device sessions):
//  - first sign-in: system browser + passkey on the product origin → authorization code + PKCE
//  - the access token lives only in memory; the rotating refresh token lives in OS secure storage
//  - later launches restore from secure storage without a new passkey ceremony or token pasting
//  - storage, network and server-rejection failures are distinct, recoverable states

export type SessionState =
  | { readonly _tag: "Loading" }
  | {
      readonly _tag: "SignedOut";
      readonly reason?:
        | "revoked"
        | "expired"
        | "logged-out"
        | "corrupt-credential"
        | "cancelled"
        | "denied"
        | "failed";
      readonly logoutPending?: boolean;
    }
  | { readonly _tag: "Authorizing"; readonly attemptId: string }
  | { readonly _tag: "SignedIn"; readonly persisted: boolean }
  /** A refresh credential exists but the service is unreachable; nothing is discarded. */
  | { readonly _tag: "Offline"; readonly detail: string }
  /** Secure storage is locked, denied or unavailable; no plaintext fallback, user may retry. */
  | {
      readonly _tag: "StorageError";
      readonly kind: SecureStoreErrorKind;
      readonly nativeCode?: string;
    }
  /**
   * Tokens were rotated/issued but the new refresh credential could not be saved. This process can
   * keep working; the session will not survive a restart until a save succeeds.
   */
  | { readonly _tag: "NotPersisted"; readonly kind: SecureStoreErrorKind };

export interface SessionClientOptions {
  /** The validated instance this session belongs to; its endpoints are the only destinations. */
  readonly instance: ValidatedInstance;
  readonly redirectUri: string;
  readonly deviceName: string;
  readonly fetch: TokenFetch;
  readonly store: SecureSessionStore;
  readonly openBrowser: (url: string) => Promise<void>;
  /** Session-only mode: never write the refresh credential; restarting requires sign-in. */
  readonly persist?: boolean;
  readonly clientId?: string;
  readonly now?: () => number;
  readonly random?: RandomBytes;
  /** Refresh this long before access expiry. */
  readonly refreshSkewMs?: number;
}

type Listener = (state: SessionState) => void;

export class SessionClient {
  private stateValue: SessionState = { _tag: "Loading" };
  private readonly listeners = new Set<Listener>();
  private readonly tokens: TokenClient;
  private readonly key: string;
  private readonly now: () => number;
  private access: { token: string; expiresAt: number } | null = null;
  private refreshToken: string | null = null;
  private scope = "";
  private attempt: AuthorizationAttempt | null = null;
  private inflight: Promise<string | null> | null = null;
  private generation = 0;
  private disposed = false;

  constructor(private readonly options: SessionClientOptions) {
    this.now = options.now ?? Date.now;
    this.tokens = new TokenClient(
      {
        token: options.instance.endpoints.token,
        revocation: options.instance.endpoints.revocation,
      },
      options.clientId ?? DESKTOP_CLIENT_ID,
      options.fetch,
      this.now,
    );
    this.key = sessionKey(options.instance.key);
  }

  /** The instance this session is bound to (never changes; switching creates a new session). */
  get instance(): ValidatedInstance {
    return this.options.instance;
  }

  /**
   * Leave this instance (switching): cancel any browser attempt so its late callback is refused,
   * drop in-memory tokens, and ignore the results of work still in flight. Stored credentials stay
   * for when the user switches back.
   */
  dispose(): void {
    this.disposed = true;
    this.attempt = null;
    this.clearMemory();
    this.listeners.clear();
  }

  get state(): SessionState {
    return this.stateValue;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.stateValue);

    return () => this.listeners.delete(listener);
  }

  private set(state: SessionState): SessionState {
    if (this.disposed) return state;
    this.stateValue = state;

    for (const l of this.listeners) l(state);

    return state;
  }

  private get persist(): boolean {
    return this.options.persist !== false;
  }

  private clearMemory(): void {
    this.generation++;
    this.access = null;
    this.refreshToken = null;
    this.scope = "";
  }

  /** Best-effort removal of the stored credential. */
  private async discardStored(): Promise<void> {
    await this.options.store.remove(this.key).catch(() => undefined);
  }

  private writeStored(refreshToken: string, scope: string): Promise<void> {
    return this.options.store.write(
      this.key,
      encodeSession({ v: 1, refreshToken, scope, savedAt: this.now() }),
    );
  }

  /**
   * Builds before instance selection kept one slot per API origin. Only a slot for exactly this
   * instance's base URL (no base path, the only shape they used) moves into the instance slot.
   */
  private async readStored(): Promise<string> {
    try {
      return await this.options.store.read(this.key);
    } catch (error) {
      const base = this.options.instance.baseUrl;

      if (toSecureStoreError(error).kind !== "MissingCredential" || !/^https:\/\/[^/]+$/.test(base))
        throw error;
      const legacy = legacySessionKey(base);
      const raw = await this.options.store.read(legacy);
      await this.options.store.write(this.key, raw);
      await this.options.store.remove(legacy).catch(() => undefined);

      return raw;
    }
  }

  /** Launch: restore the device session from secure storage (DS02). */
  async restore(): Promise<SessionState> {
    if (this.disposed) return this.stateValue;

    if (!this.persist) {
      await this.discardStored();

      return this.set({ _tag: "SignedOut" });
    }

    let stored: StoredSession;

    try {
      stored = decodeSession(await this.readStored());
    } catch (error) {
      const e = toSecureStoreError(error);

      if (e.kind === "MissingCredential") return this.set({ _tag: "SignedOut" });

      if (e.kind === "CorruptCredential") {
        await this.discardStored();

        return this.set({ _tag: "SignedOut", reason: "corrupt-credential" });
      }

      // Locked/denied/unavailable: keep whatever is stored and let the user retry.
      const failure: StorageFailureFields = {};

      if (e.nativeCode) failure.nativeCode = e.nativeCode;

      return this.set({
        _tag: "StorageError",
        kind: e.kind,
        ...failure,
      });
    }

    if (stored.pendingRevoke) {
      await this.finishPendingRevoke(stored.refreshToken);

      return this.stateValue;
    }

    this.refreshToken = stored.refreshToken;
    this.scope = stored.scope;
    await this.refreshNow();

    return this.stateValue;
  }

  /** Start browser sign-in. A new attempt supersedes any earlier one (DS04). */
  async beginSignIn(): Promise<AuthorizationAttempt> {
    if (this.disposed) throw new Error("this server is no longer selected");

    const extra: RandomFields = {};

    if (this.options.random) extra.random = this.options.random;

    const attempt = createAuthorizationAttempt({
      instance: this.options.instance,
      redirectUri: this.options.redirectUri,
      deviceName: this.options.deviceName,
      clientId: this.options.clientId ?? DESKTOP_CLIENT_ID,
      now: this.now(),
      ...extra,
    });

    this.attempt = attempt;
    this.set({ _tag: "Authorizing", attemptId: attempt.id });

    try {
      await this.options.openBrowser(attempt.url);
    } catch {
      this.attempt = null;
      this.set({ _tag: "SignedOut", reason: "failed" });
      throw new Error("could not open the browser");
    }

    return attempt;
  }

  cancelSignIn(): void {
    if (!this.attempt) return;
    this.attempt = null;
    this.set({ _tag: "SignedOut", reason: "cancelled" });
  }

  /**
   * Handle a deep link / loopback request. Returns true when it was our callback. Codes are
   * exchanged at most once per attempt; stale or foreign callbacks are ignored.
   */
  async handleCallback(url: string): Promise<boolean> {
    const result = parseCallback(url, this.attempt, this.now());

    if (Predicate.isTagged(result, "Ignored")) return result.reason !== "not-a-callback";
    const attempt = this.attempt!;
    this.attempt = null; // single use, whatever the outcome

    if (attempt.instanceKey !== this.options.instance.key) {
      // Never redeem a code anywhere but the instance whose attempt produced it.
      this.set({ _tag: "SignedOut", reason: "failed" });

      return true;
    }

    if (Predicate.isTagged(result, "Denied")) {
      this.set({
        _tag: "SignedOut",
        reason: result.error === "access_denied" ? "denied" : "failed",
      });

      return true;
    }

    if (Predicate.isTagged(result, "Invalid")) {
      this.set({ _tag: "SignedOut", reason: "failed" });

      return true;
    }

    const generation = this.generation;

    try {
      const tokens = await this.tokens.exchangeCode({
        code: result.code,
        verifier: attempt.verifier,
        redirectUri: attempt.redirectUri,
      });

      // Switched away or signed out while exchanging: the result must not restore a session.
      if (this.disposed || generation !== this.generation) return true;
      this.clearMemory();
      await this.adopt(tokens);
    } catch {
      // Codes are single-use; a failed exchange always requires a fresh browser attempt.
      this.set({ _tag: "SignedOut", reason: "failed" });
    }

    return true;
  }

  /** Current access token, refreshing if it is missing or about to expire (single-flight). */
  async accessToken(): Promise<string | null> {
    if (this.disposed) return null;
    const skew = this.options.refreshSkewMs ?? 60_000;

    if (this.access && this.access.expiresAt - skew > this.now()) return this.access.token;

    if (!this.refreshToken) return null;

    return this.refreshNow();
  }

  /** Called when the API returns 401 for the current access token. */
  async onUnauthorized(): Promise<string | null> {
    if (this.disposed) return null;
    this.access = null;

    return this.refreshToken ? this.refreshNow() : null;
  }

  /** Serialized refresh: concurrent callers share one rotation (DS06). */
  refreshNow(): Promise<string | null> {
    if (this.inflight) return this.inflight;
    const generation = this.generation;
    const token = this.refreshToken;

    if (!token) return Promise.resolve(null);
    this.inflight = (async () => {
      try {
        const next = await this.tokens.refresh(token);

        if (generation !== this.generation) return null; // signed out or replaced meanwhile
        await this.adopt(next);

        return next.accessToken;
      } catch (error) {
        if (generation !== this.generation) return null;

        if (error instanceof TransientAuthError) {
          // Keep the refresh credential; an unexpired access token remains usable (DS08).
          this.set({ _tag: "Offline", detail: error.detail });

          return this.access && this.access.expiresAt > this.now() ? this.access.token : null;
        }

        if (error instanceof OAuthError) {
          // Expired, revoked, or a replayed (rotated) credential: the device session is over.
          this.clearMemory();
          await this.discardStored();
          this.set({
            _tag: "SignedOut",
            reason: error.code === "invalid_grant" ? "revoked" : "expired",
          });

          return null;
        }

        throw error;
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  /** Save the rotated credential before reporting persistence (DS01, DS06). */
  private async adopt(tokens: TokenSet): Promise<void> {
    this.access = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    this.refreshToken = tokens.refreshToken;
    this.scope = tokens.scope;

    if (!this.persist) {
      this.set({ _tag: "SignedIn", persisted: false });

      return;
    }

    try {
      await this.writeStored(tokens.refreshToken, tokens.scope);
      this.set({ _tag: "SignedIn", persisted: true });
    } catch (error) {
      this.set({ _tag: "NotPersisted", kind: toSecureStoreError(error).kind });
    }
  }

  /** Retry a failed secure-storage write without another server rotation. */
  async retryPersist(): Promise<SessionState> {
    if (!this.refreshToken || !this.persist) return this.stateValue;

    try {
      await this.writeStored(this.refreshToken, this.scope);

      return this.set({ _tag: "SignedIn", persisted: true });
    } catch (error) {
      return this.set({ _tag: "NotPersisted", kind: toSecureStoreError(error).kind });
    }
  }

  /**
   * Sign out: revoke on the server when reachable and always drop local access. When the server is
   * unreachable the revocation stays pending (marked in secure storage) and is retried on launch
   * instead of being reported as done (DS08, DS09).
   */
  async logout(): Promise<"revoked" | "pending" | "local-only"> {
    const token = this.refreshToken;
    this.attempt = null;
    this.clearMemory();

    if (token) {
      try {
        await this.tokens.revoke(token);
      } catch (error) {
        if (error instanceof RevocationUnsupported) {
          await this.discardStored();
          this.set({ _tag: "SignedOut", reason: "logged-out" });

          return "local-only";
        }

        // An OAuthError means the credential is already invalid server-side: nothing to revoke.
        if (!(error instanceof OAuthError)) return this.deferRevoke(token);
      }
    }

    await this.discardStored();
    this.set({ _tag: "SignedOut", reason: "logged-out" });

    return "revoked";
  }

  /** The server is unreachable: mark the revocation pending in secure storage for the next launch. */
  private async deferRevoke(token: string): Promise<"pending"> {
    if (this.persist) {
      await this.options.store
        .write(
          this.key,
          encodeSession({
            v: 1,
            refreshToken: token,
            scope: "",
            savedAt: this.now(),
            pendingRevoke: true,
          }),
        )
        .catch(() => undefined);
    }

    this.set({ _tag: "SignedOut", reason: "logged-out", logoutPending: true });

    return "pending";
  }

  /**
   * Remove this instance from the device: attempt revocation once, then clear the credential slot
   * whatever the outcome (no pending retry is kept for a server the user removed).
   */
  async forget(
    options: { readonly revoke?: boolean } = {},
  ): Promise<"revoked" | "unconfirmed" | "local-only"> {
    let token = this.refreshToken;

    // Local-only: the instance's credential destinations changed, so the old token is sent nowhere.
    if (options.revoke === false) {
      this.attempt = null;
      this.clearMemory();
      await this.discardStored();
      this.set({ _tag: "SignedOut", reason: "logged-out" });
      this.dispose();

      return "local-only";
    }

    if (!token) {
      try {
        token = decodeSession(await this.options.store.read(this.key)).refreshToken;
      } catch {
        token = null;
      }
    }

    this.attempt = null;
    this.clearMemory();
    let outcome: "revoked" | "unconfirmed" | "local-only" = "revoked";

    if (token) {
      try {
        await this.tokens.revoke(token);
      } catch (error) {
        outcome =
          error instanceof RevocationUnsupported
            ? "local-only"
            : error instanceof OAuthError
              ? "revoked"
              : "unconfirmed";
      }
    }

    await this.discardStored();
    this.set({ _tag: "SignedOut", reason: "logged-out" });
    this.dispose();

    return outcome;
  }

  private async finishPendingRevoke(token: string): Promise<void> {
    try {
      await this.tokens.revoke(token);
    } catch (error) {
      if (!(error instanceof OAuthError) && !(error instanceof RevocationUnsupported)) {
        this.set({ _tag: "SignedOut", reason: "logged-out", logoutPending: true });

        return;
      }
    }

    await this.discardStored();
    this.set({ _tag: "SignedOut", reason: "logged-out" });
  }
}

export { SecureStoreError };

interface StorageFailureFields {
  nativeCode?: string;
}

interface RandomFields {
  random?: RandomBytes;
}
