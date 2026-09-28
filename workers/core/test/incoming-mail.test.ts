// Incoming-email activation (infra/onboarding/spec.md Part B): the end-to-end verification message
// and how a (re)started onboarding Workflow resumes.
import { describe, expect, it } from "vitest";
import { ControlDirectory, ControlDomains, ControlOrganizations } from "@bye/platform-cloudflare";
import { kernelClock } from "../src/durable-host.ts";
import { handleInbound } from "../src/inbound.ts";
import { recordedAuthorization } from "../src/workflows/domain.ts";
import { inboundMessage, makeHarness, rfc822 } from "./harness.ts";

describe("incoming-email verification message", () => {
  it("records a message to the domain's verification address without storing or bouncing it", async () => {
    const h = makeHarness();

    const owner = await new ControlDirectory(h.env.DIRECTORY, kernelClock).provisionPersonalAccount(
      { address: "owner@bye.test", displayName: "Owner" },
    );

    const orgId = await new ControlOrganizations(h.env.DIRECTORY, kernelClock).createOrganization(
      owner.userId,
      { name: "Example", kind: "domain", seatLimit: 2 },
    );

    const domains = new ControlDomains(h.env.DIRECTORY, kernelClock);

    const d = await domains.requestFromInstallation(orgId, owner.userId, {
      name: "example.test",
      accountId: "acc_1",
      zoneId: "zone_1",
    });

    await domains.recordAuthorization(d.id, owner.userId, "manual-records");
    const probe = (await domains.mailLink(d.id)).inboundProbe!;

    const raw = rfc822({
      from: "someone@elsewhere.test",
      to: probe.address,
      subject: "test",
      body: "hi",
      messageId: "p1@elsewhere.test",
    });

    // A wrong token is an ordinary (unknown) recipient.
    const wrong = inboundMessage(
      "someone@elsewhere.test",
      "bye-verify-000000000000000000000000@example.test",
      raw,
    );

    expect((await handleInbound(wrong, h.env))._tag).toBe("Rejected");
    expect((await domains.mailLink(d.id)).inboundProbe!.receivedAt).toBeNull();

    const message = inboundMessage("someone@elsewhere.test", probe.address, raw);
    expect(await handleInbound(message, h.env)).toEqual({ _tag: "Probe" });
    expect(message.rejected).toBeNull();
    expect((await domains.mailLink(d.id)).inboundProbe!.receivedAt).not.toBeNull();
  });
});

describe("onboarding Workflow resume", () => {
  it("resumes from the recorded authorization instead of waiting for an event again", () => {
    expect(recordedAuthorization({ zoneAuthMethod: null }, "ownership-proven", false)).toBeNull();
    expect(
      recordedAuthorization({ zoneAuthMethod: "manual-records" }, "ownership-proven", false),
    ).toBe("manual-records");
    // Authorized before the method was recorded: the automation available for the domain.
    expect(recordedAuthorization({ zoneAuthMethod: null }, "dns-configured", false)).toBe(
      "manual-records",
    );
    expect(recordedAuthorization({ zoneAuthMethod: null }, "zone-authorized", true)).toBe(
      "service-zone",
    );
  });
});
