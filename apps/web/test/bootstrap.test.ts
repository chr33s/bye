// First-owner setup link (infra/onboarding/spec.md §9): `/#bootstrap=<token>&domain=<zone>`.
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const TOKEN = "t".repeat(43);

const install = (url: string) => {
  const jsdom = new JSDOM("<!doctype html><body></body>", { url });
  Object.assign(globalThis, {
    window: jsdom.window,
    document: jsdom.window.document,
    location: jsdom.window.location,
    history: jsdom.window.history,
    HTMLElement: jsdom.window.HTMLElement,
    Node: jsdom.window.Node,
    Event: jsdom.window.Event,
  });

  return jsdom;
};

describe("bootstrap setup link", () => {
  it("parses the token and display domain, rejecting malformed values", async () => {
    install("https://bye.example.com/");
    const { parseBootstrapFragment } = await import("../src/views/auth.ts");
    expect(parseBootstrapFragment(`#bootstrap=${TOKEN}&domain=example.com`)).toEqual({
      token: TOKEN,
      domain: "example.com",
    });
    expect(parseBootstrapFragment(`#bootstrap=${TOKEN}`)).toEqual({ token: TOKEN, domain: null });
    expect(parseBootstrapFragment(`#bootstrap=${TOKEN}&domain=<script>`)).toMatchObject({
      domain: null,
    });
    expect(parseBootstrapFragment("#bootstrap=short")).toBeNull();
    expect(parseBootstrapFragment("#/mail/imbox")).toBeNull();
  });

  it("shows the selected zone as the owner address domain and drops the secret from history", async () => {
    const jsdom = install(`https://bye.example.com/#bootstrap=${TOKEN}&domain=example.com`);
    vi.resetModules();
    const { signInScreen } = await import("../src/views/auth.ts");
    const screen = signInScreen(() => undefined);
    const address = screen.querySelector<HTMLInputElement>('input[name="address"]')!;
    expect(address.placeholder).toBe("you@example.com");
    expect(screen.textContent).toContain("Create your owner account");
    expect(screen.textContent).toContain("Use an address on example.com");
    // The incoming-email state is not claimed here.
    expect(screen.textContent).toContain("Incoming email for example.com is set up separately");
    expect(jsdom.window.location.hash).toBe("");
    expect(jsdom.window.location.href).toBe("https://bye.example.com/");
  });
});
