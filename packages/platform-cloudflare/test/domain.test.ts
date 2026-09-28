import { describe, expect, it } from "vitest";
import {
  ControlDirectory,
  ControlDomains,
  ControlOrganizations,
  DEFAULT_MAIL_DNS,
  type DnsRecord,
  diagnoseMailDns,
  planMailDns,
} from "@bye/platform-cloudflare";
import { MemoryD1, TestClock } from "@bye/testing";

const profile = { ...DEFAULT_MAIL_DNS, dkimPublicKey: "MIIBKEY" };

describe("custom domains", () => {
  it("[O01] DNS plan preserves existing SPF, DMARC and flags foreign MX as a conflict", () => {
    const existing: Array<DnsRecord> = [
      { type: "MX", name: "acme.test", content: "aspmx.l.google.com", priority: 1 },
      { type: "TXT", name: "acme.test", content: '"v=spf1 include:_spf.google.com -all"' },
      { type: "TXT", name: "_dmarc.acme.test", content: "v=DMARC1; p=reject" },
      { type: "TXT", name: "acme.test", content: "google-site-verification=abc" },
    ];

    const plan = planMailDns("acme.test", existing, profile, "tok");
    expect(plan.filter((o) => o.op === "conflict" && o.purpose === "inbound")).toHaveLength(3);
    const spf = plan.find((o) => o.purpose === "spf");
    expect(spf).toMatchObject({
      op: "update",
      to: { content: "v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com -all" },
    });
    expect(plan.find((o) => o.purpose === "dmarc")).toMatchObject({ op: "keep" });
    // Nothing unrelated is touched and nothing is deleted.
    expect(plan.some((o) => JSON.stringify(o).includes("google-site-verification"))).toBe(false);
    expect(plan.every((o) => ["create", "update", "keep", "conflict"].includes(o.op))).toBe(true);
  });

  it("[O01] fresh domain gets MX, SPF, DKIM, DMARC and ownership records", () => {
    const plan = planMailDns("new.test", [], profile, "tok");
    expect(
      plan
        .filter((o) => o.op === "create")
        .map((o) => o.purpose)
        .sort(),
    ).toEqual(["dkim", "dmarc", "inbound", "inbound", "inbound", "ownership", "spf"]);

    const multi = planMailDns(
      "x.test",
      [
        { type: "TXT", name: "x.test", content: "v=spf1 a" },
        { type: "TXT", name: "x.test", content: "v=spf1 mx" },
      ],
      profile,
      "t",
    );

    expect(multi.find((o) => o.purpose.startsWith("spf"))?.op).toBe("conflict");
  });

  it("[O01] resumable onboarding state machine with diagnostics, aliases and safe removal", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();
    const dir = new ControlDirectory(d1, clock);
    const orgs = new ControlOrganizations(d1, clock);
    const domains = new ControlDomains(d1, clock);

    const admin = await dir.provisionPersonalAccount({
      address: "dana@bye.test",
      displayName: "A",
    });

    const orgId = await orgs.createOrganization(admin.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    const d = await domains.request(orgId, admin.userId, "Acme.Test.");
    expect(d.name).toBe("acme.test");
    await expect(domains.request(orgId, admin.userId, "bad_domain")).rejects.toThrow("invalid");

    await expect(dir.addAlias(admin.mailboxId, "sales@acme.test")).rejects.toThrow("not active");
    await expect(domains.proveOwnership(d.id, admin.userId, [])).rejects.toThrow("ownership");

    const txt: DnsRecord = {
      type: "TXT",
      name: "_bye-verification.acme.test",
      content: `bye-verification=${d.verification_token}`,
    };

    await domains.proveOwnership(d.id, admin.userId, [txt]);
    // Re-entrant: repeating a completed step is a no-op.
    expect((await domains.proveOwnership(d.id, admin.userId, [txt])).state).toBe(
      "ownership-proven",
    );
    await domains.authorizeZone(d.id, admin.userId, { method: "manual-records" });

    const partial = await domains.confirmDns(d.id, admin.userId, [txt], profile);
    expect(partial.domain.state).toBe("zone-authorized");
    expect(partial.diagnostics.find((x) => x.check === "mx")?.status).toBe("fail");

    const answers: Array<DnsRecord> = [
      txt,
      ...profile.mxHosts.map((h) => ({
        type: "MX" as const,
        name: "acme.test",
        content: h.host,
        priority: h.priority,
      })),
      { type: "TXT", name: "acme.test", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
      { type: "TXT", name: "bye1._domainkey.acme.test", content: "v=DKIM1; k=rsa; p=MIIBKEY" },
      { type: "TXT", name: "_dmarc.acme.test", content: "v=DMARC1; p=none" },
    ];

    expect(
      diagnoseMailDns("acme.test", answers, profile, d.verification_token).find(
        (x) => x.check === "dmarc",
      )?.status,
    ).toBe("warn");
    expect((await domains.confirmDns(d.id, admin.userId, answers, profile)).domain.state).toBe(
      "dns-configured",
    );
    await expect(
      domains.recordOutboundTest(d.id, admin.userId, {
        dkimAligned: true,
        spfPass: true,
        dmarcPass: true,
      }),
    ).rejects.toThrow("expected");
    await domains.recordInboundTest(d.id, admin.userId, true);
    await expect(
      domains.recordOutboundTest(d.id, admin.userId, {
        dkimAligned: false,
        spfPass: true,
        dmarcPass: false,
      }),
    ).rejects.toThrow("aligned");
    await domains.recordOutboundTest(d.id, admin.userId, {
      dkimAligned: true,
      spfPass: true,
      dmarcPass: true,
    });
    expect((await domains.activate(d.id, admin.userId)).state).toBe("active");

    await dir.addAlias(admin.mailboxId, "sales@acme.test");
    await domains.configure(d.id, admin.userId, { plusAddressing: false });
    expect(await dir.resolveRecipient("sales+x@acme.test")).toMatchObject({ _tag: "Rejected" });
    expect(await dir.resolveRecipient("sales@acme.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: admin.mailboxId,
    });

    const removed = await domains.remove(d.id, admin.userId);
    expect(removed.disabledRoutes).toBe(1);
    expect(await dir.resolveRecipient("sales@acme.test")).toMatchObject({ _tag: "Rejected" });
    // Mailbox and primary address are unaffected by domain removal.
    expect(await dir.resolveRecipient("dana@bye.test")).toMatchObject({
      _tag: "Deliver",
      mailboxId: admin.mailboxId,
    });
  });
});

describe("domain re-request", () => {
  it("[O01] a removed domain can be requested again; the old row keeps its history", async () => {
    const d1 = MemoryD1.migrated();
    const clock = new TestClock();

    const admin = await new ControlDirectory(d1, clock).provisionPersonalAccount({
      address: "dana@bye.test",
      displayName: "D",
    });

    const orgId = await new ControlOrganizations(d1, clock).createOrganization(admin.userId, {
      name: "Acme",
      kind: "domain",
      seatLimit: 5,
    });

    const domains = new ControlDomains(d1, clock);
    const first = await domains.request(orgId, admin.userId, "acme.test");
    await domains.remove(first.id, admin.userId);
    const again = await domains.request(orgId, admin.userId, "acme.test");
    expect(again.id).not.toBe(first.id);
    expect(again.state).toBe("requested");
    expect((await domains.get(first.id)).state).toBe("removed");
  });
});
