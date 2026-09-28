import type { Types } from "effect";
import { toBase64Url } from "@bye/domain";
import { encodeBase64 } from "@bye/mail-codec";
import { type Acceptance, type Submission, TransportFailure } from "@bye/application";
import { Effect } from "effect";
import { loadRawBytes, type RawContentSource } from "./cloudflare.ts";
import { EXTERNAL_IDENTITY_CAPABILITIES, type FetchLike, httpTransport } from "./http.ts";
import type { TransportAdapter } from "./router.ts";

// ExternalIdentityTransport (§5.3, E19): sends as an externally hosted address through the user's
// authorized provider API — Gmail API, Microsoft Graph, or a generic HTTP relay. Credentials are
// resolved per (mailbox, From) at send time, refreshed with the OAuth refresh grant when needed, and
// persisted sealed. None of these providers support idempotency keys, so any failure after the
// request left the isolate is Unknown (§5.2 ambiguous send), never a blind retry.

export type ExternalProvider = "gmail" | "graph" | "http";

export interface ExternalCredential {
  readonly provider: ExternalProvider;
  /** Generic HTTP relay endpoint (provider "http"). */
  readonly endpoint?: string;
  readonly apiKey?: string;
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  /** Epoch ms. */
  readonly expiresAt?: number;
}

export interface ExternalCredentialStore {
  readonly resolve: (from: string) => Promise<ExternalCredential | null>;
  readonly persist: (from: string, credential: ExternalCredential) => Promise<void>;
}

/** Provider calls never hang a queue consumer: every request carries a deadline. */
export const EXTERNAL_REQUEST_TIMEOUT_MS = 30_000;

const refresh = async (
  fetchFn: FetchLike,
  c: ExternalCredential,
  timeoutMs: number,
): Promise<ExternalCredential | null> => {
  if (!c.refreshToken || !c.tokenEndpoint || !c.clientId) return null;

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: c.refreshToken,
    client_id: c.clientId,
  });

  if (c.clientSecret) params.set("client_secret", c.clientSecret);
  const body = params.toString();

  const response = await fetchFn(c.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (response.status !== 200) return null;

  const json = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!json.access_token) return null;

  const refreshed: Types.Mutable<ExternalCredential> = {
    ...c,
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };

  if (json.refresh_token) refreshed.refreshToken = json.refresh_token;

  return refreshed;
};

/**
 * Single-flight OAuth refresh per identity (isolate-local). Concurrent sends for one identity share
 * one refresh-grant request: providers that rotate refresh tokens invalidate the old one on first
 * use, so racing refreshes would revoke each other and strand the account.
 */
const inflightRefreshes = new Map<string, Promise<ExternalCredential | null>>();

interface CredentialRefresh {
  readonly leader: boolean;
  readonly result: Promise<ExternalCredential | null>;
}

const refreshOnce = (
  key: string,
  run: () => Promise<ExternalCredential | null>,
): CredentialRefresh => {
  const pending = inflightRefreshes.get(key);

  if (pending) return { leader: false, result: pending };
  const result = run().finally(() => inflightRefreshes.delete(key));
  inflightRefreshes.set(key, result);

  return { leader: true, result };
};

interface ExternalSendResult {
  readonly status: number;
  readonly id?: string;
}

const send = async (
  fetchFn: FetchLike,
  c: ExternalCredential,
  raw: Uint8Array,
  timeoutMs: number,
): Promise<ExternalSendResult> => {
  if (c.provider === "gmail") {
    const r = await fetchFn("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${c.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: toBase64Url(raw) }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const id = r.status === 200 ? ((await r.json()) as { id?: string }).id : undefined;

    const sent: Types.Mutable<ExternalSendResult> = { status: r.status };

    if (id) sent.id = id;

    return sent;
  }

  const r = await fetchFn("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { authorization: `Bearer ${c.accessToken}`, "content-type": "text/plain" },
    // Standard base64 of the message bytes (Graph's MIME send format).
    body: encodeBase64(raw),
    signal: AbortSignal.timeout(timeoutMs),
  });

  return { status: r.status };
};

export const makeExternalIdentityApiTransport = (
  store: ExternalCredentialStore,
  content: RawContentSource,
  fetchFn: FetchLike,
  now: () => number = Date.now,
  timeoutMs: number = EXTERNAL_REQUEST_TIMEOUT_MS,
): TransportAdapter => ({
  capabilities: EXTERNAL_IDENTITY_CAPABILITIES,
  submit: (submission: Submission) =>
    Effect.gen(function* () {
      const credential = yield* Effect.tryPromise({
        try: () => store.resolve(submission.from),
        catch: () =>
          new TransportFailure({
            kind: "RetryableBeforeAcceptance",
            detail: "credential store unavailable",
          }),
      });

      if (!credential)
        return yield* new TransportFailure({
          kind: "Rejected",
          detail: "no authorized credential for this identity",
        });

      if (credential.provider === "http") {
        if (!credential.endpoint || !credential.apiKey)
          return yield* new TransportFailure({
            kind: "Rejected",
            detail: "incomplete relay credential",
          });

        return yield* httpTransport(
          {
            endpoint: credential.endpoint,
            apiKey: credential.apiKey,
            capabilities: EXTERNAL_IDENTITY_CAPABILITIES,
            timeoutMs,
          },
          content,
          fetchFn,
        ).submit(submission);
      }

      const raw = yield* Effect.tryPromise({
        try: async () => {
          const bytes = await loadRawBytes(content, submission.contentKey);

          if (bytes === null) throw new Error("rendered content missing");

          return bytes;
        },
        catch: (e) =>
          new TransportFailure({
            kind: "RetryableBeforeAcceptance",
            detail: e instanceof Error ? e.message : "content",
          }),
      });

      // Only the refresh leader persists; followers reuse the leader's result.
      const refreshAndPersist = (c: ExternalCredential) =>
        Effect.tryPromise({
          try: async () => {
            const flight = refreshOnce(
              `${submission.from.toLowerCase()}\0${c.refreshToken ?? ""}`,
              () => refresh(fetchFn, c, timeoutMs),
            );

            const refreshed = await flight.result;

            if (refreshed && flight.leader) await store.persist(submission.from, refreshed);

            return refreshed;
          },
          catch: () =>
            new TransportFailure({
              kind: "RetryableBeforeAcceptance",
              detail: "token refresh failed",
            }),
        });

      let active = credential;

      if (!active.accessToken || (active.expiresAt ?? 0) < now() + 60_000) {
        const refreshed = yield* refreshAndPersist(active);

        if (!refreshed)
          return yield* new TransportFailure({
            kind: "Rejected",
            detail: "authorization expired; reconnect the account",
          });
        active = refreshed;
      }

      let result = yield* Effect.tryPromise({
        try: () => send(fetchFn, active, raw, timeoutMs),
        catch: () =>
          new TransportFailure({ kind: "Unknown", detail: "network error after submit" }),
      });

      if (result.status === 401) {
        // Unauthorized means not accepted: refresh once and retry.
        const refreshed = yield* refreshAndPersist(active);

        if (!refreshed)
          return yield* new TransportFailure({
            kind: "Rejected",
            detail: "authorization revoked; reconnect the account",
          });
        active = refreshed;
        result = yield* Effect.tryPromise({
          try: () => send(fetchFn, active, raw, timeoutMs),
          catch: () =>
            new TransportFailure({ kind: "Unknown", detail: "network error after submit" }),
        });
      }

      if (result.status >= 200 && result.status < 300) {
        const acceptance: Acceptance = {
          providerId: result.id ?? `${active.provider}:${submission.sendJobId}`,
        };

        return acceptance;
      }

      if (result.status === 429 || result.status === 408)
        return yield* new TransportFailure({
          kind: "RetryableBeforeAcceptance",
          detail: `http ${result.status}`,
        });

      if (result.status >= 500)
        return yield* new TransportFailure({ kind: "Unknown", detail: `http ${result.status}` });

      return yield* new TransportFailure({ kind: "Rejected", detail: `http ${result.status}` });
    }).pipe(Effect.withSpan("transport.external.submit")),
});
