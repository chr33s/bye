/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import axe from "axe-core";
import { JSDOM } from "jsdom";
import { build } from "rolldown";
import { beforeAll, describe, expect, it } from "vitest";

// §13 accessibility: the production bundle (built exactly as build.ts does, but as an IIFE so it
// can run in jsdom) renders each screen against a stubbed API, and axe-core (pinned) must report
// no WCAG 2.x A/AA violations. Colour contrast needs layout, which jsdom lacks, so it is disabled.

const root = fileURLToPath(new URL("..", import.meta.url));
let bundle = "";

beforeAll(async () => {
  const out = await build({
    input: `${root}src/main.ts`,
    platform: "browser",
    write: false,
    output: { format: "iife", minify: true },
  });
  bundle = out.output[0].code;
}, 60_000);

type Stub = (method: string, path: string) => { status: number; body: unknown };

const me = { userId: "usr_1", mailboxIds: ["mbx_1"], calendarIds: ["cal_1"] };
const threads = [
  {
    threadId: "thr_1",
    subject: "Quarterly numbers",
    sender: "Bob <bob@example.net>",
    newForYou: true,
    revision: 1,
    bundleCount: 0,
    lastActivityAt: Date.UTC(2026, 8, 25),
    snippet: "See attached",
  },
  {
    threadId: "thr_2",
    subject: "Lunch",
    sender: "ana@example.net",
    newForYou: false,
    revision: 3,
    bundleCount: 2,
    lastActivityAt: Date.UTC(2026, 8, 24),
  },
];

const signedIn: Stub = (_method, path) => {
  if (path === "/v1/me") return { status: 200, body: me };
  if (path.includes("/views/"))
    return { status: 200, body: { items: threads, nextCursor: null, boundary: 10 } };
  return { status: 200, body: { items: [] } };
};

const render = async (hash: string, stub: Stub) => {
  const html = readFileSync(`${root}public/index.html`, "utf8").replace(
    /<script[^>]*src="https:[^"]*"[^>]*><\/script>/g,
    "",
  );
  const dom = new JSDOM(html, {
    url: `https://app.bye.test/${hash}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const window = dom.window as unknown as Window &
    typeof globalThis & { eval(code: string): unknown; axe: typeof axe };
  Object.defineProperty(window, "fetch", {
    value: async (input: string, init?: RequestInit) => {
      const r = stub(init?.method ?? "GET", new URL(input, "https://app.bye.test").pathname);
      return new Response(
        JSON.stringify(
          r.status >= 400 ? { error: { code: "unauthenticated", message: "Sign in" } } : r.body,
        ),
        { status: r.status, headers: { "content-type": "application/json" } },
      );
    },
  });
  Object.defineProperty(window, "WebSocket", {
    value: class {
      addEventListener() {}
      close() {}
      send() {}
    },
  });
  window.eval(bundle);
  // Let the async route() settle.
  for (
    let i = 0;
    i < 20 && window.document.querySelector("main p")?.textContent === "Loading…";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
  window.eval(axe.source);
  const result = await window.axe.run(window.document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return {
    window,
    violations: result.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
    ),
  };
};

describe("a11y (axe-core 4.13.0, WCAG 2.1 A/AA)", () => {
  it("the harness detects a known violation (guards against a silently passing setup)", async () => {
    const { window } = await render("#/mail/imbox", () => ({ status: 401, body: null }));
    window.document.body.append(
      Object.assign(window.document.createElement("img"), { src: "x.png" }),
    );
    const result = await window.axe.run(window.document, {
      runOnly: { type: "rule", values: ["image-alt"] },
    });
    expect(result.violations.map((v) => v.id)).toEqual(["image-alt"]);
  });

  it("signed-out screen", async () => {
    const { window, violations } = await render("#/mail/imbox", () => ({
      status: 401,
      body: null,
    }));
    expect(window.document.querySelector("#auth-title")?.textContent).toBe("Sign in");
    expect(violations).toEqual([]);
  });

  it("imbox with new and previously seen threads", async () => {
    const { window, violations } = await render("#/mail/imbox", signedIn);
    expect(window.document.querySelector("#view-title")).not.toBeNull();
    expect(violations).toEqual([]);
  });

  it("compose", async () => {
    const { violations } = await render("#/compose", signedIn);
    expect(violations).toEqual([]);
  });

  it("error state", async () => {
    const { violations } = await render("#/mail/imbox", () => ({ status: 500, body: null }));
    expect(violations).toEqual([]);
  });
});
