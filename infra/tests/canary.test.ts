import { describe, expect, it } from "vitest";
import { canaryDecision, canaryPercent, DURABLE_MANIFEST } from "../policies/canary.ts";
import { RATE_LIMIT_RULES, serviceZones, stateEnv, WAF_RULES } from "../foundation/stack.ts";
import { runProbes, versionOverrideHeader } from "../probes/run.ts";
import { mailRoutingZone, requireStage } from "../resources/stage.ts";

describe("canary covers async paths (§15.9)", () => {
  it("uses the requested percentage unless class migrations changed", () => {
    expect(canaryPercent(10, ["workers/core/src/api.ts"])).toMatchObject({ percent: 10 });
    expect(canaryPercent(10, [DURABLE_MANIFEST])).toMatchObject({ percent: 100 });
    expect(canaryPercent(0, [])).toMatchObject({ percent: 100 });
    expect(canaryPercent(100, [])).toMatchObject({ percent: 100 });
  });

  it("promotes only when HTTP and every async probe (queue, alarm, workflow) passed", () => {
    const ok = (name: string) => ({ name, ok: true });

    const all = [
      ok("http.unauthenticated"),
      ok("queue.round-trip"),
      ok("do.alarm"),
      ok("workflow.checkpoint"),
    ];

    expect(canaryDecision({ results: all })).toBe("promote");
    expect(
      canaryDecision({
        results: all.map((r) => (r.name === "do.alarm" ? { ...r, ok: false } : r)),
      }),
    ).toBe("rollback");
    expect(canaryDecision({ results: [ok("http.unauthenticated")] })).toBe("rollback");
    expect(canaryDecision({ results: [] })).toBe("rollback");
  });
});

describe("canary probes target the new version", () => {
  it("every probe request carries Cloudflare-Workers-Version-Overrides when a version is given", async () => {
    const seen: Array<string | undefined> = [];

    const fetcher = async (_url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers["cloudflare-workers-version-overrides"]);

      return new Response("{}", { status: 500 });
    };

    const override = {
      worker: "mailboxplatform-prod-mailcore",
      versionId: "dc8dcd28-271b-4367-9840-6c244f84cb40",
    };

    await runProbes("https://app.test", "t", fetcher, 0, override);
    expect(seen.length).toBeGreaterThan(3);

    for (const h of seen)
      expect(h).toBe('mailboxplatform-prod-mailcore="dc8dcd28-271b-4367-9840-6c244f84cb40"');
    seen.length = 0;
    await runProbes("https://app.test", "t", fetcher, 0);

    for (const h of seen) expect(h).toBeUndefined();
    expect(() => versionOverrideHeader({ worker: 'x"; y', versionId: "abc" })).toThrow();
  });
});

describe("zone ownership and MX cutover (§15.4, §15.8)", () => {
  it("Email Routing is only enabled after an explicit MX cutover approval, never on previews", () => {
    const zone = "mail.example";

    for (const name of ["prod", "staging", "dev-abcdef"]) {
      const stage = requireStage(name);
      expect(mailRoutingZone(stage, zone, "approved")).toBe(zone);

      for (const cutover of [undefined, "", "yes", "APPROVED", "approved "])
        expect(mailRoutingZone(stage, zone, cutover)).toBeUndefined();
      expect(mailRoutingZone(stage, undefined, "approved")).toBeUndefined();
    }

    expect(mailRoutingZone(requireStage("preview-12"), zone, "approved")).toBeUndefined();
  });

  it("the foundation stack's custom-phase WAF ruleset blocks probes and odd methods; auth bursts are rate limited", () => {
    const byDescription = Object.fromEntries(WAF_RULES.map((r) => [r.description, r]));
    expect(Object.keys(byDescription)).toHaveLength(WAF_RULES.length);
    const probes = byDescription["Block secret/dotfile probes"]!;
    expect(probes.action).toBe("block");

    for (const path of ['"/.env"', '"/.git"']) expect(probes.expression).toContain(path);
    expect(probes.expression).toContain("lower(http.request.uri.path)");

    const methods = byDescription["Block unexpected methods"]!;
    expect(methods.action).toBe("block");
    const allowed = /\{([^}]*)\}/.exec(methods.expression)?.[1]?.match(/"[A-Z]+"/g);
    expect(allowed?.map((m) => m.slice(1, -1)).sort()).toEqual([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "PATCH",
      "POST",
      "PUT",
    ]);
    expect(methods.expression.startsWith("not ")).toBe(true);

    // The deprecated threat score is not used; auth bursts are rate limited at the edge instead.
    for (const r of WAF_RULES) expect(r.expression).not.toContain("threat_score");
    const [auth] = RATE_LIMIT_RULES;
    expect(auth.expression).toContain('starts_with(http.request.uri.path, "/auth/")');
    expect(auth.expression).toContain('starts_with(http.request.uri.path, "/oauth/")');
    expect(auth.ratelimit.characteristics).toEqual(["cf.colo.id", "ip.src"]);
    expect(auth.ratelimit.requestsPerPeriod).toBeGreaterThan(0);
  });

  it("the foundation covers every listed service zone; the first keeps its original IDs", () => {
    expect(serviceZones("")).toEqual([]);
    expect(serviceZones("example.com, Mail.Example.net ,example.com")).toEqual([
      { name: "example.com", id: "" },
      { name: "mail.example.net", id: "-mail-example-net" },
    ]);
  });

  it("the state Worker binds the operator-only admin token (empty = admin routes off)", () => {
    expect(Object.keys(stateEnv)).toContain("STATE_ADMIN_TOKEN");
  });
});
