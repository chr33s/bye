// Domain page incoming-email section (infra/onboarding/spec.md Part B): every state offers an action.
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.ts", () => ({ stepUpWithPasskey: vi.fn() }));

const jsdom = new JSDOM("<!doctype html><body></body>", { url: "https://bye.example.test/" });
const g = globalThis as Record<string, unknown>;
for (const k of ["window", "document", "location", "history", "HTMLElement", "Node", "Event"])
  g[k] = (jsdom.window as unknown as Record<string, unknown>)[k];
g.localStorage = jsdom.window.localStorage;

const { incomingMailSection } = await import("../src/views/incoming-mail.ts");

const domain = (state: string, workflow: string | null) => ({
  id: "dom_1",
  name: "example.test",
  state,
  workflow: workflow ? { id: "wf", status: workflow } : null,
});
const info = {
  zone: "example.test",
  automation: "manual-records" as const,
  canSetup: true,
  domain: null,
  incomingMail: "not-set-up" as const,
};
const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent);

describe("incoming-mail section", () => {
  it("offers a retry and a restart when the current setup can't be read", () => {
    const el = incomingMailSection(
      domain("ownership-proven", "errored"),
      {},
      info,
      () => undefined,
    );
    expect(el.textContent).toContain("could not read the current mail setup");
    expect(buttons(el)).toEqual(["Try again", "Restart setup"]);
  });

  it("lists the records to restore by hand after a manual rollback", () => {
    const el = incomingMailSection(
      domain("ownership-proven", null),
      {
        classification: {
          kind: "new",
          provider: null,
          currentMx: [],
          conflicts: [],
          requiresCutover: false,
        },
        plan: [],
        link: {
          installZoneId: "z",
          cutoverConfirmedAt: null,
          hasSnapshot: false,
          restorePending: {
            mx: [{ type: "MX", name: "example.test", content: "aspmx.l.google.com", priority: 1 }],
            spf: [],
            dkim: [],
            dmarc: [],
            routing: null,
          },
        },
      },
      info,
      () => undefined,
    );
    expect(el.textContent).toContain("MX example.test 1 aspmx.l.google.com");
    expect(buttons(el)).toContain("I've restored these");
    expect(buttons(el)).toContain("Enable incoming email");
  });

  it("holds a pending switch after authorization and shows the verification address", () => {
    const el = incomingMailSection(
      domain("dns-configured", "running"),
      {
        cutoverPending: true,
        classification: {
          kind: "existing-provider",
          provider: "Cloudflare Email Routing forwarding",
          currentMx: [],
          conflicts: [],
          requiresCutover: true,
        },
        plan: [],
        link: {
          installZoneId: "z",
          cutoverConfirmedAt: null,
          hasSnapshot: true,
          inboundProbe: { address: "bye-verify-abc@example.test", receivedAt: null },
        },
      },
      info,
      () => undefined,
    );
    expect(el.textContent).toContain("Confirm the switch to continue");
    expect(el.textContent).toContain("bye-verify-abc@example.test");
    expect(buttons(el)).toEqual(
      expect.arrayContaining([
        "Continue",
        "Retry checks",
        "Restore previous mail setup",
        "Switch incoming email to Bye",
      ]),
    );
  });

  it("offers Bye-made changes with a zone-limited token, or manual records", () => {
    const newDomain = {
      classification: {
        kind: "new" as const,
        provider: null,
        currentMx: [],
        conflicts: [],
        requiresCutover: false,
      },
      plan: [],
    };
    const manual = incomingMailSection(
      domain("ownership-proven", null),
      newDomain,
      info,
      () => undefined,
    );
    expect(buttons(manual)).toContain("Let Bye make the changes");
    expect(buttons(manual)).toContain("I'll add the records myself");
    const form = manual.querySelector("form")!;
    expect(form.hidden).toBe(true);
    expect(form.textContent).toContain("Zone → DNS → Edit");
    expect(form.textContent).toContain("Zone → Email Routing Rules → Edit");
    expect(form.textContent).toContain("Zone → Zone Settings → Edit");
    expect(form.textContent).toContain("Specific zone → example.test");
    expect(form.querySelector<HTMLInputElement>("input")!.type).toBe("password");

    const automated = incomingMailSection(
      domain("ownership-proven", null),
      newDomain,
      { ...info, automation: "zone-api" as const, tokenConfigured: true },
      () => undefined,
    );
    expect(automated.textContent).toContain("Bye will make these changes in Cloudflare");
    expect(buttons(automated)).toContain(
      "Remove the Cloudflare token (I'll add the records myself)",
    );
    // Another customer domain (not the installation zone) gets no token chooser.
    const other = incomingMailSection(
      { ...domain("ownership-proven", null), name: "other.test" },
      newDomain,
      info,
      () => undefined,
    );
    expect(buttons(other)).not.toContain("Let Bye make the changes");
  });
});
