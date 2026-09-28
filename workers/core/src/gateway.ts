import { WorkerEntrypoint } from "cloudflare:workers";
import { sanitizeHtml } from "@bye/mail-codec";
import { publishedKey } from "@bye/domain";
import { space, world } from "./authorities.ts";
import type { CoreEnv } from "./env.ts";
import { bodyKeyFor, type StoredBody } from "./objects.ts";
import { escapeHtml } from "./html.ts";
import { sendSubscriptionConfirmation, SystemMailRefused } from "./publishing.ts";

// Narrow RPC entrypoint for the Public worker (§11, §15.5). It exposes only share-link resolution
// and subscription actions; grants are rechecked by the owning SharedSpaceDO on every call.

const HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const GATEWAY_CONCURRENCY = 4;

/**
 * A bearer link is only as good as its creator's current access. The space authority re-checks
 * space membership and grants; organization membership lives in D1, so a creator who was removed
 * from or suspended in the space's organization (which never touches the space authority) no
 * longer keeps their links alive — the same binding `orgSpace` applies to every space route.
 */
const creatorInSpaceOrg = async (env: CoreEnv, spaceId: string, userId: string) =>
  (await env.DIRECTORY.withSession("first-primary")
    .prepare(
      "SELECT 1 AS ok FROM spaces s JOIN memberships m ON m.org_id = s.org_id WHERE s.id = ? AND m.user_id = ? AND m.status = 'active'",
    )
    .bind(spaceId, userId)
    .first()) !== null;

export class PublicGateway extends WorkerEntrypoint<CoreEnv> {
  async resolveShareLink(spaceId: string, token: string) {
    if (!/^[a-z0-9_-]{4,64}$/i.test(spaceId)) return null;
    const result = await space(this.env, spaceId).resolvePublicLink(token);

    if (!result.ok) return null;
    const createdBy = (result.value as { createdBy?: string }).createdBy;

    if (createdBy !== undefined && !(await creatorInSpaceOrg(this.env, spaceId, createdBy)))
      return null;
    // Bounded concurrency: a long shared thread never fans out unbounded R2 reads per request.
    const messages: Array<{ from: string; date: number; subject: string; html: string }> = [];

    // bounded: fixed-size chunks of GATEWAY_CONCURRENCY
    for (let i = 0; i < result.value.messages.length; i += GATEWAY_CONCURRENCY) {
      messages.push(
        ...(await Promise.all(
          result.value.messages.slice(i, i + GATEWAY_CONCURRENCY).map(async (m) => {
            const body = await this.env.PARTS.get(bodyKeyFor(m.contentKey));
            const stored = body ? ((await body.json()) as StoredBody) : null;

            // Stored HTML is sanitized but keeps remote image URLs (the private render origin proxies
            // them per viewer); a public page never loads them, nor inline parts, and drops <style>
            // blocks: every message shares one document here, so a stylesheet would restyle the page
            // (spoofed headers, hidden messages). Text is escaped.
            const html =
              stored?.html != null
                ? sanitizeHtml(stored.html, {
                    proxyImage: () => null,
                    cid: () => null,
                    blockRemoteImages: true,
                    allowStyleBlocks: false,
                  }).html
                : `<p>${escapeHtml(stored?.text ?? m.snippet)}</p>`;

            return {
              from: m.from.name ? `${m.from.name}` : m.from.address,
              date: m.sentAt,
              subject: m.subject,
              html,
            };
          }),
        )),
      );
    }

    return { subject: result.value.subject, messages };
  }

  /**
   * The World authority for a handle that has a public site. An unknown handle never reaches a
   * Durable Object (which would create state for it on first call): the published index — the only
   * page carrying the subscribe form — is the cheap existence check.
   */
  private async world(handle: string) {
    if (!HANDLE.test(handle)) return null;

    if (!(await this.env.PUBLISHED.head(publishedKey.index(handle)))) return null;

    return world(this.env, handle);
  }

  async subscribe(handle: string, address: string) {
    const stub = await this.world(handle);

    if (!stub) return { ok: false };
    const result = await stub.subscribe(address);

    // A suppressed address is dropped silently: the anonymous form never learns suppression state.
    if (result.ok && result.value.confirmToken)
      await sendSubscriptionConfirmation(
        this.env,
        handle,
        address,
        result.value.confirmToken,
      ).catch((error) => {
        if (!(error instanceof SystemMailRefused)) throw error;
      });

    return { ok: result.ok };
  }

  async confirmSubscription(handle: string, token: string) {
    const stub = await this.world(handle);

    if (!stub) return { ok: false };
    const result = await stub.confirm(token);

    return { ok: result.ok && result.value };
  }

  async unsubscribe(handle: string, address: string, token: string) {
    const stub = await this.world(handle);

    if (!stub) return { ok: false };
    const result = await stub.unsubscribe(address, token);

    return { ok: result.ok && result.value };
  }
}
