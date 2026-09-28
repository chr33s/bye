import { ControlAuth, ControlDirectory } from "@bye/platform-cloudflare";
import { describe, expect, it } from "vitest";
import { handleFetch } from "../src/api.ts";
import { kernelClock } from "../src/durable-host.ts";
import { routingUrl } from "../src/http.ts";
import { authConfig } from "../src/services.ts";
import { executionContext, type Harness, makeHarness } from "./harness.ts";

// Router lookup rules that must match the pathname-regex router the HttpRouter replaced.

const signup = async (h: Harness) => {
  const account = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
    { address: "ana@bye.test", displayName: "ana" },
  );

  await h.env.CALENDARS.getByName(account.calendarId).provision({
    ownerId: account.userId,
    selfAddresses: [account.address],
    defaultZone: "UTC",
  });

  const session = await new ControlAuth(
    h.env.DIRECTORY,
    kernelClock,
    await authConfig(h.env),
  ).issueSession(account.userId, "test", true);

  return { ...account, cookie: `__Host-session=${session.token}` };
};

const call = async (
  h: Harness,
  credential: { readonly cookie?: string; readonly bearer?: string },
  method: string,
  path: string,
  body?: string,
) => {
  const headers = new Headers({ origin: h.env.APP_ORIGIN, "content-type": "application/json" });

  if (credential.cookie) headers.set("cookie", credential.cookie);

  if (credential.bearer) headers.set("authorization", `Bearer ${credential.bearer}`);

  const response = await handleFetch(
    new Request(`${h.env.APP_ORIGIN}${path}`, { method, headers, body }),
    h.env,
    executionContext,
  );

  return { status: response.status, body: await response.text() };
};

describe("router lookup", () => {
  it("keeps `;` inside the path segment and the first of a repeated query key", () => {
    expect(routingUrl(new URL("https://x.test/v1/me;x"))).toBe("/v1/me%3Bx");
    expect(routingUrl(new URL("https://x.test/v1/s?q=a&limit=1&q=b&limit=2"))).toBe(
      "/v1/s?q=a&limit=1",
    );
    expect(routingUrl(new URL("https://x.test/v1/s?"))).toBe("/v1/s");
  });

  it("never routes `/v1/me;x` to `/v1/me`", async () => {
    const h = makeHarness();
    const ana = await signup(h);

    expect((await call(h, ana, "GET", "/v1/me")).status).toBe(200);
    expect((await call(h, ana, "GET", "/v1/me;x")).status).toBe(404);
    expect((await call(h, ana, "POST", "/v1/tokens;x", "{}")).status).toBe(404);
  });

  it("answers HEAD as a method no route has, never running the GET handler", async () => {
    const h = makeHarness();
    const ana = await signup(h);

    const head = await call(h, ana, "HEAD", "/v1/me");

    expect(head.status).toBe(400);
    expect((await call(h, ana, "HEAD", "/v1/nope")).status).toBe(404);
  });

  it("reads the first value of a repeated query key", async () => {
    const h = makeHarness();
    const ana = await signup(h);

    const r = await call(
      h,
      ana,
      "GET",
      `/v1/mailboxes/${ana.mailboxId}/search?q=a&q=b&limit=1&limit=2`,
    );

    expect(r.status, r.body).toBe(200);
  });

  it("refuses a calendar command from a credential without the calendar scope before decoding it", async () => {
    const h = makeHarness();
    const ana = await signup(h);

    const created = await call(
      h,
      ana,
      "POST",
      "/v1/tokens",
      JSON.stringify({ label: "read-only", scopes: ["read"] }),
    );

    expect(created.status, created.body).toBe(201);
    const { token } = JSON.parse(created.body) as { token: string };

    const r = await call(
      h,
      { bearer: token },
      "POST",
      `/v1/calendars/${ana.calendarId}/commands`,
      "{}",
    );

    expect(r.status, r.body).toBe(403);
  });
});
