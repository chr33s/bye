import { describe, expect, it } from "vitest";
import { ALL_ROUTES, handleFetch } from "../src/api.ts";
import { makeHarness } from "./harness.ts";

// P0.6a (spec.md §13.3): every /v1 route refuses a caller without credentials before it
// reads a body or touches an authority. Routes that are deliberately public are listed here, so
// adding one is a reviewed change rather than an accident.

const PUBLIC_V1 = new Set<string>([
  // Signed, expiring capability tokens are the authorization (E20 large files, A04 exports, C08 photos).
  "GET /v1/files/x_1/x_1",
  "GET /v1/downloads",
  "GET /v1/calendar-photos",
  // The Web Push application server key is public by design (E23).
  "GET /v1/push/vapid-key",
]);

const ctx = {
  waitUntil() {},
  passThroughOnCallback() {},
  props: {},
} as unknown as ExecutionContext;

/** A concrete path for a route pattern: each `:param` becomes a plausible, well-formed ID. */
const samplePath = (pattern: RegExp): string =>
  pattern.source.slice(1, -1).replaceAll("([^/]+)", "x_1").replaceAll("\\/", "/");

describe("[A03] route authorization", () => {
  const v1 = ALL_ROUTES.filter((r) => r.pattern.source.startsWith("^\\/v1\\/"));

  it("enumerates the /v1 surface", () => {
    expect(v1.length).toBeGreaterThan(50);
  });

  it("every non-public /v1 route answers 401 without credentials", async () => {
    const h = makeHarness();
    const open: Array<string> = [];
    for (const r of v1) {
      const path = samplePath(r.pattern);
      const key = `${r.method} ${path}`;
      const response = await handleFetch(
        new Request(`${h.env.APP_ORIGIN}${path}`, {
          method: r.method,
          headers: {
            ...(r.method === "GET" ? {} : { origin: h.env.APP_ORIGIN }),
            "content-type": "application/json",
          },
          ...(r.method === "GET" || r.method === "HEAD" ? {} : { body: "{}" }),
        }),
        h.env,
        ctx,
      );
      if (PUBLIC_V1.has(key)) {
        // Capability routes still refuse a request without a valid token.
        if (key !== "GET /v1/push/vapid-key")
          expect([401, 403, 404], key).toContain(response.status);
        continue;
      }
      if (response.status !== 401) open.push(`${key} → ${response.status}`);
    }
    expect(open).toEqual([]);
  });
});
