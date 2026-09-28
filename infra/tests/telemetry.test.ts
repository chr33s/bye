import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  missingTelemetryOptOuts,
  REQUIRED_DEPLOY_ENV,
  scriptsMissingOptOut,
} from "../policies/telemetry.ts";

const root = `${import.meta.dirname}/../../`;

describe("deployment privacy (§15.7)", () => {
  it("every alchemy-invoking package script disables CLI telemetry inline", () => {
    const scripts = JSON.parse(readFileSync(`${root}package.json`, "utf8")).scripts as Record<
      string,
      string
    >;

    expect(Object.values(scripts).some((s) => /\balchemy (deploy|plan|destroy)\b/.test(s))).toBe(
      true,
    );
    expect(scriptsMissingOptOut(scripts)).toEqual([]);
    expect(scriptsMissingOptOut({ bad: "alchemy deploy --stage prod" })).toEqual(["bad"]);
  });

  it("the CI workflow exports every opt-out", () => {
    const ci = `${root}.github/workflows/ci.yml`;
    expect(existsSync(ci)).toBe(true);
    const text = readFileSync(ci, "utf8");

    for (const [k, v] of Object.entries(REQUIRED_DEPLOY_ENV))
      expect(text).toContain(`${k}: "${v}"`);
  });

  it("reports missing opt-outs", () => {
    expect(missingTelemetryOptOuts({ ALCHEMY_TELEMETRY_DISABLED: "1" })).toEqual([
      "DO_NOT_TRACK",
      "NO_TRACK",
    ]);
  });

  it("uses opaque stack and resource names", async () => {
    // The compiled stack carries its name at runtime; the Effect type does not expose it.
    const stack: { stackName: string } = (await import("../stack.ts")).default as never;
    const { INVENTORY } = await import("../resources/inventory.ts");
    // Names reach Cloudflare as physical resource names and in the deploy telemetry we opt out of.
    expect(stack.stackName).toBe("MailboxPlatform");

    for (const name of [stack.stackName, ...INVENTORY.map((e) => e.logicalId)])
      expect(name).toMatch(/^[A-Z][A-Za-z0-9]*$/);
  });
});
