import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireStage } from "../resources/stage.ts";
import { coreEnv, observabilityFor, publicEnvBase } from "../resources/workers.ts";
import { CORE_BINDING_NAMES } from "../../workers/core/src/env.ts";

// The MailCore Worker declares its runtime bindings by hand so its bundle never imports
// deployment modules (§7.5). This test keeps that declaration identical to the stack's graph.

describe("worker binding contract (§15.4)", () => {
  it("MailCore runtime bindings match the declared stack bindings exactly", () => {
    expect([...CORE_BINDING_NAMES].sort()).toEqual(Object.keys(coreEnv).sort());
  });

  it("the Public worker receives no private mailbox, blob, queue or authority bindings", () => {
    const privateNames = [
      "DIRECTORY",
      "ORIGINALS",
      "PARTS",
      "EXPORTS",
      "MAILBOXES",
      "CALENDARS",
      "SHARED_SPACES",
      "SEARCH_SHARDS",
      "INGRESS_JOURNALS",
      "SESSION_KEY",
      "PERSONAL_MAIL_API_KEY",
    ];
    for (const name of privateNames) expect(Object.keys(publicEnvBase)).not.toContain(name);
  });

  it("the Public worker binds its subscribe limiter and the render origin (same value as MailCore)", () => {
    expect(Object.keys(publicEnvBase)).toEqual(
      expect.arrayContaining(["PUBLIC_RATE_LIMIT", "SUBSCRIBE_RATE_LIMIT", "MAIL_ORIGIN"]),
    );
    expect(publicEnvBase.SUBSCRIBE_RATE_LIMIT).not.toBe(publicEnvBase.PUBLIC_RATE_LIMIT);
    // Both read the same stage config name, so the two workers can never disagree on the origin.
    const source = readFileSync(join(import.meta.dirname, "../resources/workers.ts"), "utf8");
    const publicBlock = source.slice(source.indexOf("export const publicEnvBase"));
    expect(publicBlock).toMatch(/MAIL_ORIGIN: Config\.String\("MAIL_RENDER_ORIGIN"\)/);
    expect(source.slice(0, source.indexOf("export const publicEnvBase"))).toMatch(
      /MAIL_ORIGIN: Config\.String\("MAIL_RENDER_ORIGIN"\)/,
    );
  });
});

describe("deployment privacy of request URLs (§10, §15.7)", () => {
  it("automatic invocation logs, which record full URLs with bearer tokens, are disabled", () => {
    for (const name of ["prod", "staging", "preview-1", "dev-abcdef"]) {
      const observability = observabilityFor(requireStage(name));
      expect(observability.logs).toMatchObject({ enabled: true, invocationLogs: false });
      // Not carried by the pinned Alchemy upload, so it must not be relied upon.
      expect(observability.logs).not.toHaveProperty("redactQueryString");
      // Metric, DLQ and review log lines are the operational record: never head-sampled away.
      expect(observability.headSamplingRate).toBe(1);
    }
  });
});
