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

const code = <Caught>(e: Caught) => (e instanceof Rejection ? e.code : String(e));

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

describe("incoming email for the onboarding-selected zone (infra/onboarding/spec.md Part B)", () => {
  const installed = async () => {
    const s = await setup();
    const zoneId = s.cf.addZone("example.test");

    const d = await s.domains.requestFromInstallation(s.orgId, s.owner.userId, {
      name: "Example.test.",
      accountId: "acc_1",
      zoneId,
    });

    return { ...s, zoneId, d };
  };

  it("binds the installation zone at ownership-proven, re-entrantly, and never to another zone", async () => {
    const { orgs, domains, owner, orgId, zoneId, d, clock, d1 } = await installed();
    expect(d).toMatchObject({ name: "example.test", state: "ownership-proven" });

    const again = await domains.requestFromInstallation(orgId, owner.userId, {
      name: "example.test",
      accountId: "acc_1",
      zoneId,
    });

    expect(again.id).toBe(d.id);
    expect(
      code(
        await domains
          .requestFromInstallation(orgId, owner.userId, {
            name: "example.test",
            accountId: "acc_1",
            zoneId: "zone-other",
          })
          .catch((e) => e),
      ),
    ).toBe("conflict");

    // Another organization cannot take the bound name.
    const other = await new ControlDirectory(d1, clock).provisionPersonalAccount({
      address: "eve@bye.test",
      displayName: "Eve",
    });

    const eveOrg = await orgs.createOrganization(other.userId, {
      name: "Eve",
      kind: "domain",
      seatLimit: 1,
    });

    expect(
      code(
        await domains
          .requestFromInstallation(eveOrg, other.userId, {
            name: "example.test",
            accountId: "acc_1",
            zoneId,
          })
          .catch((e) => e),
      ),
    ).toBe("conflict");
  });

  it("classifies new, existing-provider and conflicted setups before any write", async () => {
    const { cf, zoneId, d, onboarding } = await installed();
    const ob = onboarding(true);
    expect((await ob.preview(d.id)).classification).toMatchObject({
      kind: "new",
      provider: null,
      requiresCutover: false,
    });
    cf.records.push({
      id: "mx",
      zoneId,
      type: "MX",
      name: "example.test",
      content: "in1-smtp.messagingengine.com",
      priority: 10,
    });
    expect((await ob.preview(d.id)).classification).toMatchObject({
      kind: "existing-provider",
      provider: "Fastmail",
      requiresCutover: true,
    });
    cf.records.push(
      { id: "s1", zoneId, type: "TXT", name: "example.test", content: "v=spf1 -all" },
      { id: "s2", zoneId, type: "TXT", name: "example.test", content: "v=spf1 ~all" },
    );
    const conflicted = (await ob.preview(d.id)).classification;
    expect(conflicted.kind).toBe("conflicted");
    expect(conflicted.conflicts.map((c) => c.purpose)).toContain(
      "spf (multiple SPF records are invalid)",
    );
    cf.records.splice(-2, 2);
    cf.records.push({
      id: "dk",
      zoneId,
      type: "TXT",
      name: "bye1._domainkey.example.test",
      content: "v=DKIM1; k=rsa; p=someoneelse",
    });
    expect((await ob.preview(d.id)).classification.conflicts[0]?.purpose).toBe(
      "dkim selector in use",
    );
    // Previews wrote nothing.
    expect(cf.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  it("confirmed cutover replaces the foreign MX, merges SPF, keeps DMARC and unrelated records; rollback restores", async () => {
    const { cf, zoneId, d, onboarding, domains, owner, d1 } = await installed();

    const foreign = [
      {
        id: "g1",
        zoneId,
        type: "MX" as const,
        name: "example.test",
        content: "aspmx.l.google.com",
        priority: 1,
      },
      {
        id: "spf",
        zoneId,
        type: "TXT" as const,
        name: "example.test",
        content: "v=spf1 include:_spf.google.com ~all",
      },
      {
        id: "dmarc",
        zoneId,
        type: "TXT" as const,
        name: "_dmarc.example.test",
        content: "v=DMARC1; p=reject",
      },
      { id: "www", zoneId, type: "CNAME" as const, name: "www.example.test", content: "x.test" },
    ];

    cf.records.push(...foreign.map((r) => ({ ...r })));
    const ob = onboarding(true);

    // Without the confirmation, even an authorized zone keeps the foreign MX.
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" });
    const held = await ob.configureDns(d.id, owner.userId);
    expect(held.conflicts.some((c) => c.purpose === "inbound")).toBe(true);
    expect(cf.records.find((r) => r.id === "g1")).toBeDefined();
    // The pre-change snapshot was recorded before the first write.
    const snap = (await domains.mailLink(d.id)).snapshot!;
    expect(snap.mx.map((r) => r.content)).toEqual(["aspmx.l.google.com"]);
    expect(snap.routing).toEqual({ enabled: false, catchAll: null, rules: [] });

    await domains.recordCutover(d.id, owner.userId, snap, true);
    const dns = await ob.configureDns(d.id, owner.userId);
    expect(dns.conflicts).toEqual([]);

    const mx = () =>
      cf.records
        .filter((r) => r.type === "MX")
        .map((r) => r.content)
        .sort();

    expect(mx()).toEqual([
      "route1.mx.cloudflare.net",
      "route2.mx.cloudflare.net",
      "route3.mx.cloudflare.net",
    ]);
    const spf = cf.records.filter((r) => r.type === "TXT" && r.content.startsWith("v=spf1"));
    expect(spf).toHaveLength(1);
    expect(spf[0]!.content).toBe(
      "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all",
    );
    expect(cf.records.find((r) => r.id === "dmarc")!.content).toBe("v=DMARC1; p=reject");
    expect(cf.records.find((r) => r.id === "www")).toMatchObject({ content: "x.test" });

    // Not active until inbound is verified; routing enables only in the inbound step.
    expect((await domains.get(d.id)).state).toBe("dns-configured");
    expect(cf.routing.get(zoneId)).toEqual({ enabled: false, catchAll: null });
    expect((await ob.testInbound(d.id, owner.userId)).passed).toBe(true);
    expect(cf.routing.get(zoneId)).toEqual({ enabled: true, catchAll: "mailcore" });
    expect((await domains.get(d.id)).state).not.toBe("active");

    // Mail already accepted for the owner stays: rollback never touches mailboxes or routes.
    const routesBefore = await d1.prepare("SELECT COUNT(*) AS n FROM address_routes").first();
    const back = await ob.rollback(d.id, owner.userId);
    expect(back.domain.state).toBe("ownership-proven");
    expect(mx()).toEqual(["aspmx.l.google.com"]);
    expect(
      cf.records.filter((r) => r.type === "TXT" && r.content.startsWith("v=spf1"))[0]!.content,
    ).toBe("v=spf1 include:_spf.google.com ~all");
    expect(cf.records.some((r) => r.name === "bye1._domainkey.example.test")).toBe(false);
    expect(cf.records.find((r) => r.id === "dmarc")!.content).toBe("v=DMARC1; p=reject");
    expect(cf.records.find((r) => r.id === "www")).toBeDefined();
    expect(cf.routing.get(zoneId)).toEqual({ enabled: false, catchAll: null });
    expect(await d1.prepare("SELECT COUNT(*) AS n FROM address_routes").first()).toEqual(
      routesBefore,
    );
    expect((await domains.mailLink(d.id)).cutoverConfirmedAt).toBeNull();
    // A retry resumes from zone authorization.
    expect(
      (await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" })).state,
    ).toBe("zone-authorized");
  });

  it("refuses a zone the API reaches that is not the installation's", async () => {
    const { cf, d, onboarding, owner, d1 } = await installed();
    await d1
      .prepare("UPDATE domains SET install_zone_id = 'zone-elsewhere' WHERE id = ?")
      .bind(d.id)
      .run();
    const ob = onboarding(true);
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" });
    expect(code(await ob.configureDns(d.id, owner.userId).catch((e) => e))).toBe("conflict");
    expect(cf.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
  });

  const authorized = async (automated = true) => {
    const s = await installed();
    const ob = s.onboarding(automated);
    await ob.domains.recordCutover(s.d.id, s.owner.userId, await ob.snapshot(s.d.id), false);
    await ob.domains.recordAuthorization(
      s.d.id,
      s.owner.userId,
      automated ? "delegated-token" : "manual-records",
    );
    await ob.domains.authorizeZone(s.d.id, s.owner.userId, {
      method: automated ? "delegated-token" : "manual-records",
    });

    return { ...s, ob };
  };

  const forwardRule = {
    enabled: true,
    name: "to gmail",
    matchers: [{ type: "all" }],
    actions: [{ type: "forward", value: ["someone@gmail.test"] }],
  };

  const cfMx = (zoneId: string) =>
    ["route1", "route2", "route3"].map((h, i) => ({
      id: `cfmx${i}`,
      zoneId,
      type: "MX" as const,
      name: "example.test",
      content: `${h}.mx.cloudflare.net`,
      priority: 10 * (i + 1),
    }));

  it("treats Cloudflare Email Routing that forwards elsewhere as an existing provider", async () => {
    const { cf, zoneId, d, onboarding } = await installed();
    cf.records.push(...cfMx(zoneId));
    cf.routing.get(zoneId)!.enabled = true;
    cf.setCatchAll(zoneId, forwardRule);
    const ob = onboarding(true);
    expect((await ob.preview(d.id)).classification).toMatchObject({
      kind: "existing-provider",
      provider: "Cloudflare Email Routing forwarding",
      requiresCutover: true,
    });
    // An address rule forwarding elsewhere counts too.
    cf.setCatchAll(zoneId, { ...forwardRule, enabled: false });
    cf.routingRules.set(zoneId, [
      {
        enabled: true,
        matchers: [{ type: "literal", field: "to", value: "ceo@example.test" }],
        actions: [{ type: "forward", value: ["ceo@gmail.test"] }],
      },
    ]);
    expect((await ob.preview(d.id)).classification.requiresCutover).toBe(true);
    // Routing that already delivers to MailCore is not a provider to replace.
    cf.routingRules.set(zoneId, []);
    cf.setCatchAll(zoneId, { ...forwardRule, actions: [{ type: "worker", value: ["mailcore"] }] });
    expect((await ob.preview(d.id)).classification).toMatchObject({
      kind: "new",
      requiresCutover: false,
    });
    // Without zone access the rules can't be read: Cloudflare MX still needs a confirmation.
    expect((await onboarding(false).preview(d.id)).classification).toMatchObject({
      kind: "existing-provider",
      provider: "Cloudflare Email Routing (its current rules are not visible to Bye)",
      requiresCutover: true,
    });
  });

  it("never replaces a catch-all that delivers elsewhere without a confirmed cutover, and restores it exactly", async () => {
    const { cf, zoneId, d, ob, owner, domains } = await authorized();
    cf.setCatchAll(zoneId, forwardRule);
    // Snapshot was taken before the forward rule existed; record the real pre-change state.
    await ob.domains.rewindAfterRollback(
      d.id,
      owner.userId,
      {},
      {
        expected: "zone-authorized",
        restorePending: null,
      },
    );
    const snap = await ob.snapshot(d.id);
    expect(snap.routing?.catchAll).toEqual(forwardRule);
    await domains.recordCutover(d.id, owner.userId, snap, false);
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "delegated-token" });
    expect((await ob.configureDns(d.id, owner.userId)).domain.state).toBe("dns-configured");
    const held = await ob.testInbound(d.id, owner.userId);
    expect(held.passed).toBe(false);
    expect(held.detail).toMatch(/confirm the switch/);
    expect(cf.catchAllRules.get(zoneId)).toEqual(forwardRule);
    expect((await ob.preview(d.id)).cutoverPending).toBe(true);

    await domains.recordCutover(d.id, owner.userId, snap, true);
    expect((await ob.testInbound(d.id, owner.userId)).passed).toBe(true);
    expect(cf.routing.get(zoneId)!.catchAll).toBe("mailcore");
    expect((await domains.mailLink(d.id)).writeMode).toBe("api");

    const back = await ob.rollback(d.id, owner.userId);
    expect(back.manual).toBeNull();
    expect(back.domain.state).toBe("ownership-proven");
    expect(cf.catchAllRules.get(zoneId)).toEqual(forwardRule);
  });

  it("adds Bye's MX before removing the previous provider's", async () => {
    const { cf, zoneId, d, ob, owner, domains } = await installed().then(async (s) => {
      s.cf.records.push({
        id: "g1",
        zoneId: s.zoneId,
        type: "MX",
        name: "example.test",
        content: "aspmx.l.google.com",
        priority: 1,
      });
      const ob = s.onboarding(true);
      await ob.domains.recordCutover(s.d.id, s.owner.userId, await ob.snapshot(s.d.id), true);
      await ob.domains.authorizeZone(s.d.id, s.owner.userId, { method: "delegated-token" });

      return { ...s, ob };
    });

    cf.calls.length = 0;
    await ob.configureDns(d.id, owner.userId);
    const writes = cf.calls.filter((c) => !c.startsWith("GET"));
    const firstDelete = writes.findIndex((c) => c.startsWith("DELETE"));
    expect(firstDelete).toBeGreaterThan(2); // three MX creates first
    expect(writes.slice(0, 3).every((c) => c.startsWith("POST"))).toBe(true);
    expect(cf.records.some((r) => r.content === "aspmx.l.google.com")).toBe(false);
    expect((await domains.mailLink(d.id)).writeMode).toBe("api");
    expect(zoneId).toBeTruthy();
  });

  it("decides the cutover from authoritative zone records, not stale public answers", async () => {
    const { cf, d, onboarding } = await installed();
    // Public DNS still answers with an old provider the zone no longer has.
    cf.external.push({
      id: "stale",
      type: "MX",
      name: "example.test",
      content: "aspmx.l.google.com",
      priority: 1,
    });
    const viaApi = await onboarding(true).preview(d.id);
    expect(viaApi.source).toBe("zone-api");
    expect(viaApi.classification.requiresCutover).toBe(false);
    expect((await onboarding(false).preview(d.id)).classification.requiresCutover).toBe(true);
  });

  it("manual records: MX alone never passes inbound; the verification message does", async () => {
    const { cf, zoneId, d, ob, owner, domains } = await authorized(false);
    cf.records.push(...cfMx(zoneId));
    await domains.recordCutover(d.id, owner.userId, await ob.snapshot(d.id), true);

    // Publish the rest of the records by hand (the plan's creates), then verify.
    for (const op of (await ob.preview(d.id)).plan)
      if (op.op === "create")
        cf.records.push({ id: `m${cf.records.length}`, zoneId, ...op.record });
    expect((await ob.configureDns(d.id, owner.userId)).domain.state).toBe("dns-configured");
    const waiting = await ob.testInbound(d.id, owner.userId);
    expect(waiting.passed).toBe(false);
    const probe = (await domains.mailLink(d.id)).inboundProbe!;
    expect(waiting.detail).toContain(probe.address);
    expect(probe.address).toMatch(/^bye-verify-[a-f0-9]{24}@example\.test$/);
    expect(
      await domains.recordInboundProbe("bye-verify-000000000000000000000000@example.test"),
    ).toBe(false);
    expect(await domains.recordInboundProbe(probe.address.toUpperCase())).toBe(true);
    expect((await ob.testInbound(d.id, owner.userId)).passed).toBe(true);
    expect((await domains.get(d.id)).state).toBe("inbound-tested");
  });

  it("manual rollback keeps the recorded setup until the owner restores it, and reuses it as the next snapshot", async () => {
    const { cf, zoneId, d, ob, owner, domains } = await installed().then(async (s) => {
      s.cf.records.push({
        id: "g1",
        zoneId: s.zoneId,
        type: "MX",
        name: "example.test",
        content: "aspmx.l.google.com",
        priority: 1,
      });
      const ob = s.onboarding(false);
      await ob.domains.recordCutover(s.d.id, s.owner.userId, await ob.snapshot(s.d.id), true);
      await ob.domains.recordAuthorization(s.d.id, s.owner.userId, "manual-records");
      await ob.domains.authorizeZone(s.d.id, s.owner.userId, { method: "manual-records" });

      return { ...s, ob };
    });

    // The owner switched MX by hand; then verification failed and they restore.
    cf.records.splice(
      cf.records.findIndex((r) => r.id === "g1"),
      1,
    );
    cf.records.push(...cfMx(zoneId));
    expect((await ob.rollbackPlan(d.id)).mode).toBe("manual");
    const back = await ob.rollback(d.id, owner.userId);
    expect(back.manual?.mx.map((r) => r.content)).toEqual(["aspmx.l.google.com"]);
    const link = await domains.mailLink(d.id);
    expect(link.restorePending?.mx.map((r) => r.content)).toEqual(["aspmx.l.google.com"]);
    expect(link.snapshot).toBeNull();
    expect(link.zoneAuthMethod).toBeNull();
    // A new attempt records the still-pending original, not Bye's MX, as its snapshot.
    await domains.recordCutover(d.id, owner.userId, await ob.snapshot(d.id), true);
    const again = await domains.mailLink(d.id);
    expect(again.snapshot?.mx.map((r) => r.content)).toEqual(["aspmx.l.google.com"]);
    expect(again.restorePending).toBeNull();
    // Acknowledging clears a pending restore.
    await ob.domains.authorizeZone(d.id, owner.userId, { method: "manual-records" });
    await ob.rollback(d.id, owner.userId);
    expect((await domains.acknowledgeRestore(d.id, owner.userId)).restorePending).toBeNull();
  });

  it("rolls back through the path the change was made, and never against a state it did not see", async () => {
    const { d, ob, owner, domains, onboarding } = await authorized(true);
    // Authorized for the API but nothing written through it yet: restore is manual.
    expect((await ob.rollbackPlan(d.id)).mode).toBe("manual");
    await domains.recordWriteMode(d.id, "api");
    expect((await ob.rollbackPlan(d.id)).mode).toBe("api");
    // With the API gone, the recorded setup is handed to the customer instead.
    expect((await onboarding(false).rollbackPlan(d.id)).mode).toBe("manual");
    expect(
      code(
        await domains
          .rewindAfterRollback(
            d.id,
            owner.userId,
            {},
            {
              expected: "dns-configured",
              restorePending: null,
            },
          )
          .catch((e) => e),
      ),
    ).toBe("conflict");
    expect((await domains.get(d.id)).state).toBe("zone-authorized");
    // Nothing to restore once rewound.
    await ob.rollback(d.id, owner.userId);
    expect(code(await ob.rollbackPlan(d.id).catch((e) => e))).toBe("conflict");
  });
});
