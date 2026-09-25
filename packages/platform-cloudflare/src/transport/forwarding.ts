import { type Submission, TransportFailure } from "@bye/application";
import { Effect } from "effect";
import { arcSeal, type ArcSigner, binaryToBytes, bytesToBinary, splitMessage } from "./arc.ts";
import { loadRawBytes, type RawContentSource } from "./cloudflare.ts";
import { FORWARDING_CAPABILITIES, type FetchLike, makeHttpTransport } from "./http.ts";
import type { TransportAdapter } from "./router.ts";
import { type SrsConfig, srsForward } from "./srs.ts";

// ForwardingTransport (§5.3, §5.4 Forwarding gate): forwards the ORIGINAL stored message — never a
// resend with a forged From. The envelope sender is SRS-rewritten into our domain (SPF-aligned,
// bounces reversible), an ARC set records the authentication we observed, and a hop marker plus
// the ARC instance limit stop forwarding loops.

export const MAX_FORWARD_HOPS = 5;
export const LOOP_HEADER = "X-Bye-Loop";
/** Receiving authority whose Authentication-Results we trust (our MX). */
export const TRUSTED_AUTHSERV = "mx.cloudflare.net";

export interface ForwardingConfig {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly srs: SrsConfig;
  readonly signer: ArcSigner | null;
  /** Our authserv-id in the ARC-Authentication-Results we add. */
  readonly authservId: string;
  readonly timeoutMs?: number;
}

const headerValue = (headers: ReadonlyArray<readonly [string, string]>, name: string) =>
  headers.find(([n]) => n.trim().toLowerCase() === name)?.[1]?.trim();

/**
 * Results from our trusted MX, e.g. "spf=pass; dkim=pass; dmarc=pass; arc=none". Only the TOPMOST
 * Authentication-Results header is ours (our MX prepends it); anything further down came from the
 * sender or earlier hops and may be forged with our authserv-id, so it is never consulted. Without
 * a trustworthy verdict the prior ARC chain is treated as failed (cv=fail), never as passing.
 */
export const trustedResults = (
  headers: ReadonlyArray<readonly [string, string]>,
): { readonly results: string; readonly arc: "pass" | "fail" | "none" } => {
  const top = headers.find(([name]) => name.trim().toLowerCase() === "authentication-results");
  if (!top) return { results: "none", arc: "fail" };
  const [authserv, ...rest] = top[1].replace(/\r?\n[ \t]+/g, " ").split(";");
  if (authserv?.trim().toLowerCase() !== TRUSTED_AUTHSERV) return { results: "none", arc: "fail" };
  const results = rest
    .map((r) => r.trim())
    .filter(Boolean)
    .join("; ");
  const arc = /\barc=(pass|fail|none)/i.exec(results)?.[1]?.toLowerCase() as
    | "pass"
    | "fail"
    | "none"
    | undefined;
  return { results: results || "none", arc: arc ?? "fail" };
};

export type PreparedForward =
  | {
      readonly _tag: "Ready";
      /** The sealed message bytes, exactly as they go to the provider. */
      readonly raw: Uint8Array<ArrayBuffer>;
      readonly envelopeFrom: string;
      readonly hops: number;
    }
  | { readonly _tag: "Loop"; readonly reason: string };

/** Pure preparation: loop guard, SRS envelope, ARC seal. Works on bytes end to end. */
export const prepareForward = async (
  config: ForwardingConfig,
  original: Uint8Array | string,
  fallbackSender: string,
  now = Date.now(),
): Promise<PreparedForward> => {
  const raw = bytesToBinary(
    typeof original === "string" ? new TextEncoder().encode(original) : original,
  );
  const { headers } = splitMessage(raw);
  const hops = headers.filter(
    ([n, v]) =>
      n.trim().toLowerCase() === LOOP_HEADER.toLowerCase() &&
      v.trim().toLowerCase() === config.srs.domain.toLowerCase(),
  ).length;
  if (hops >= MAX_FORWARD_HOPS) return { _tag: "Loop", reason: `hop limit ${MAX_FORWARD_HOPS}` };
  const returnPath = headerValue(headers, "return-path")?.replace(/^<|>$/g, "") ?? "";
  const envelopeFrom = await srsForward(config.srs, returnPath || fallbackSender, now);
  let sealed = `${LOOP_HEADER}: ${config.srs.domain}\r\n${raw}`;
  if (config.signer) {
    const observed = trustedResults(headers);
    const result = await arcSeal({
      raw: sealed,
      signer: config.signer,
      authResults: `${config.authservId}; ${observed.results}`,
      priorChain: observed.arc,
      now,
    });
    if (result._tag === "LoopLimit") return { _tag: "Loop", reason: "ARC instance limit" };
    sealed = result.raw;
  }
  return { _tag: "Ready", raw: binaryToBytes(sealed), envelopeFrom, hops: hops + 1 };
};

export const makeSealedForwardingTransport = (
  config: ForwardingConfig,
  content: RawContentSource,
  fetchFn: FetchLike,
): TransportAdapter => ({
  capabilities: FORWARDING_CAPABILITIES,
  submit: (submission: Submission) =>
    Effect.gen(function* () {
      const raw = yield* Effect.tryPromise({
        try: async () => {
          const bytes = await loadRawBytes(content, submission.contentKey);
          if (bytes === null) throw new Error("original missing");
          return bytes;
        },
        catch: (e) =>
          new TransportFailure({
            kind: "RetryableBeforeAcceptance",
            detail: e instanceof Error ? e.message : "content",
          }),
      });
      const prepared = yield* Effect.tryPromise({
        try: () => prepareForward(config, raw, submission.from),
        catch: (e) =>
          new TransportFailure({
            kind: "Rejected",
            detail: e instanceof Error ? e.message : "prepare",
          }),
      });
      if (prepared._tag === "Loop")
        return yield* new TransportFailure({
          kind: "Rejected",
          detail: `forwarding loop: ${prepared.reason}`,
        });
      const inner = makeHttpTransport(
        {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          capabilities: FORWARDING_CAPABILITIES,
          ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        },
        { load: async () => prepared.raw },
        fetchFn,
      );
      return yield* inner.submit({ ...submission, from: prepared.envelopeFrom });
    }).pipe(Effect.withSpan("transport.forwarding.submit")),
});
