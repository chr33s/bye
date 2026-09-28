import { describe, expect, it } from "vitest";
import { API_SURFACE, handleFetch } from "../src/api.ts";
import { RequestServices, SchemaErrors } from "../src/httpapi.ts";
import { CoreApi } from "../src/spec/index.ts";
import { executionContext, makeHarness } from "./harness.ts";

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

const ctx = executionContext;

/** A concrete path for a route pattern: each `:param` becomes a plausible, well-formed ID. */
const samplePath = (path: string): string => path.replace(/:[a-zA-Z]+/g, "x_1");

describe("[A03] route authorization", () => {
  const v1 = API_SURFACE.filter((r) => r.path.startsWith("/v1/"));

  it("every HttpApi endpoint authenticates and maps schema errors", () => {
    // Group middleware applies only to endpoints added before it: an endpoint added after
    // `.middleware(...)` would run unauthenticated.
    for (const group of Object.values(CoreApi.groups))
      for (const endpoint of Object.values(group.endpoints))
        expect([...endpoint.middlewares], `${endpoint.method} ${endpoint.path}`).toEqual(
          expect.arrayContaining([RequestServices, SchemaErrors]),
        );
  });

  it("enumerates the /v1 surface", () => {
    expect(v1.length).toBeGreaterThan(50);
  });

  it("every non-public /v1 route answers 401 without credentials", async () => {
    const h = makeHarness();
    const open: Array<string> = [];

    for (const r of v1) {
      const path = samplePath(r.path);
      const key = `${r.method} ${path}`;

      const requestHeaders = new Headers({ "content-type": "application/json" });

      if (r.method !== "GET") requestHeaders.set("origin", h.env.APP_ORIGIN);

      const response = await handleFetch(
        new Request(
          `${h.env.APP_ORIGIN}${path}`,
          r.method === "GET" || r.method === "HEAD"
            ? { method: r.method, headers: requestHeaders }
            : { method: r.method, headers: requestHeaders, body: "{}" },
        ),
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
