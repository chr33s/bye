import { describe, expect, it } from "vitest";
import {
  cloudflareApi,
  ControlDirectory,
  ControlDomains,
  ControlOrganizations,
  dohResolver,
  DomainOnboarding,
  mailDnsProfile,
} from "@bye/platform-cloudflare";
import { FakeCloudflare, MemoryD1, TestClock } from "@bye/testing";
import { Rejection } from "@bye/platform-cloudflare";

const DKIM = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtest";

const setup = async () => {
  const d1 = MemoryD1.migrated();
  const clock = new TestClock();
  const cf = new FakeCloudflare();
  const dir = new ControlDirectory(d1, clock);
  const owner = await dir.provisionPersonalAccount({
    address: "owner@bye.test",
    displayName: "Owner",
  });
  const orgs = new ControlOrganizations(d1, clock);
  const orgId = await orgs.createOrganization(owner.userId, {
    name: "Acme",
    kind: "domain",
    seatLimit: 5,
  });
  const domains = new ControlDomains(d1, clock);
  const onboarding = (automated: boolean) =>
    new DomainOnboarding(d1, clock, {
      api: automated ? cloudflareApi("cf-test-token", cf.fetch) : null,
      resolve: dohResolver(cf.fetch),
      profile: mailDnsProfile(DKIM),
      workerName: "mailcore",
    });
  return { d1, clock, cf, owner, orgId, domains, onboarding, orgs };
};

const code = (e: unknown) => (e instanceof Rejection ? e.code : String(e));

describe("[O01] customer-domain onboarding through a scoped Cloudflare API", () => {
  it("proves ownership, applies DNS, enables routing, verifies alignment and activates", async () => {
    const { cf, owner, orgId, domains, onboarding } = await setup();
    const zoneId = cf.addZone("acme.test");
    const d = await domains.request(orgId, owner.userId, "Acme.test.");
    expect(d.name).toBe("acme.test");
    const ob = onboarding(true);
    // Without the TXT record, proof fails (and the step is retryable).
    expect(code(await ob.proveOwnership(d.id, owner.userId).catch((e) => e))).toBe("conflict");
    cf.external.push({
      id: "x1",
      type: "TXT",
      name: `_bye-verification.acme.test`,
      content: `bye-verification=${d.verification_token}`,
    });
    expect((await ob.proveOwnership(d.id, owner.userId)).state).toBe("ownership-proven");
    // Idempotent on replay.
    expect((await ob.proveOwnership(d.id, owner.userId)).state).toBe("ownership-proven");
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" });

    const preview = await ob.preview(d.id);
    expect(preview.plan.filter((op) => op.op === "create").length).toBeGreaterThanOrEqual(5);

    const dns = await ob.configureDns(d.id, owner.userId);
    expect(dns.conflicts).toEqual([]);
    expect(dns.domain.state).toBe("dns-configured");
    expect(
      cf.records
        .filter((r) => r.zoneId === zoneId && r.type === "MX")
        .map((r) => r.content)
        .sort(),
    ).toEqual(["route1.mx.cloudflare.net", "route2.mx.cloudflare.net", "route3.mx.cloudflare.net"]);

    const inbound = await ob.testInbound(d.id, owner.userId);
    expect(inbound.passed).toBe(true);
    expect(cf.routing.get(zoneId)).toEqual({ enabled: true, catchAll: "mailcore" });

    expect((await ob.testOutbound(d.id, owner.userId)).passed).toBe(true);
    expect((await ob.activate(d.id, owner.userId)).state).toBe("active");
    // Replays after activation are no-ops.
    expect((await ob.activate(d.id, owner.userId)).state).toBe("active");
  });

  it("never overwrites a foreign record: conflicts block advancement until the customer resolves them", async () => {
    const { cf, owner, orgId, domains, onboarding } = await setup();
    const zoneId = cf.addZone("acme.test");
    cf.records.push({
      id: "foreign-dmarc",
      zoneId,
      type: "TXT",
      name: "_dmarc.acme.test",
      content: "v=DMARC1; p=reject; rua=mailto:someone@else.test",
    });
    cf.records.push({
      id: "foreign-mx",
      zoneId,
      type: "MX",
      name: "acme.test",
      content: "mx.other-provider.test",
      priority: 5,
    });
    const d = await domains.request(orgId, owner.userId, "acme.test");
    cf.external.push({
      id: "x1",
      type: "TXT",
      name: `_bye-verification.acme.test`,
      content: `bye-verification=${d.verification_token}`,
    });
    const ob = onboarding(true);
    await ob.proveOwnership(d.id, owner.userId);
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" });
    await ob.configureDns(d.id, owner.userId);
    // The foreign MX stays; inbound readiness requires MX to point only at the service.
    expect(cf.records.find((r) => r.id === "foreign-mx")?.content).toBe("mx.other-provider.test");
    const inbound = await ob.testInbound(d.id, owner.userId);
    expect(inbound.passed).toBe(false);
    expect((await domains.get(d.id)).state).not.toBe("active");
  });

  it("manual-records path verifies customer-published records without zone API access", async () => {
    const { cf, owner, orgId, domains, onboarding } = await setup();
    const d = await domains.request(orgId, owner.userId, "manual.test");
    const ob = onboarding(false);
    cf.external.push({
      id: "v",
      type: "TXT",
      name: "_bye-verification.manual.test",
      content: `bye-verification=${d.verification_token}`,
    });
    await ob.proveOwnership(d.id, owner.userId);
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "manual-records" });
    const blocked = await ob.configureDns(d.id, owner.userId);
    expect(blocked.domain.state).toBe("zone-authorized");
    expect(blocked.diagnostics.some((x) => x.status === "fail")).toBe(true);
    // The customer publishes the planned records by hand.
    for (const op of (await ob.preview(d.id)).plan)
      if (op.op === "create") cf.external.push({ id: `m${cf.external.length}`, ...op.record });
    expect((await ob.configureDns(d.id, owner.userId)).domain.state).toBe("dns-configured");
    expect(cf.calls.some((c) => c.includes("/client/v4"))).toBe(false);
  });

  it("aliases on an active domain are org-scoped, reserved-address aware and removable", async () => {
    const { d1, clock, owner, orgId, domains } = await setup();
    await d1
      .prepare(
        "INSERT INTO domains (id, org_id, name, state, verification_token, created_at, updated_at) VALUES ('dom_a', ?, 'acme.test', 'active', 't', ?, ?)",
      )
      .bind(orgId, clock.now(), clock.now())
      .run();
    const mbx = (await d1
      .prepare("SELECT id FROM mailboxes WHERE owner_user_id = ?")
      .bind(owner.userId)
      .first<{ id: string }>())!.id;
    // A personal mailbox belongs to the personal org, not the domain org.
    expect(
      code(
        await domains
          .addAlias("dom_a", owner.userId, { localPart: "sales", mailboxId: mbx })
          .catch((e) => e),
      ),
    ).toBe("forbidden");
    await d1
      .prepare(
        "INSERT INTO mailboxes (id, org_id, owner_user_id, kind, created_at) VALUES ('mbx_org', ?, ?, 'personal', ?)",
      )
      .bind(orgId, owner.userId, clock.now())
      .run();
    expect(
      await domains.addAlias("dom_a", owner.userId, { localPart: "Sales", mailboxId: "mbx_org" }),
    ).toEqual({ address: "sales@acme.test" });
    expect(
      code(
        await domains
          .addAlias("dom_a", owner.userId, { localPart: "sales", mailboxId: "mbx_org" })
          .catch((e) => e),
      ),
    ).toBe("conflict");
    expect(
      code(
        await domains
          .addAlias("dom_a", owner.userId, { localPart: "bad..local", mailboxId: "mbx_org" })
          .catch((e) => e),
      ),
    ).toBe("bad_request");
    expect((await domains.listAliases("dom_a")).map((a) => a.address)).toEqual(["sales@acme.test"]);
    expect(await domains.removeAlias("dom_a", owner.userId, "sales@acme.test")).toBe(true);
    expect((await domains.listAliases("dom_a"))[0]?.disabled).toBe(true);
    // Re-adding a removed alias within the same domain works.
    expect(
      await domains.addAlias("dom_a", owner.userId, { localPart: "sales", mailboxId: "mbx_org" }),
    ).toEqual({ address: "sales@acme.test" });
  });

  it("cache purge is chunked at 30 URLs per request", async () => {
    const cf = new FakeCloudflare();
    const zone = cf.addZone("bye.test");
    await cloudflareApi("cf-test-token", cf.fetch).purgeUrls(
      zone,
      Array.from({ length: 65 }, (_, i) => `https://bye.test/p${i}`),
    );
    expect(cf.purged.map((p) => p.length)).toEqual([30, 30, 5]);
    await expect(cloudflareApi("wrong", cf.fetch).findZone("bye.test")).rejects.toThrow();
  });
});
