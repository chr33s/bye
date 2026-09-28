import { Config, ConfigProvider, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { missingConfig } from "../policies/check-config.ts";
import { childEnv } from "../onboarding/executor.ts";
import {
  domainDefaults,
  domainStageMismatch,
  hostConfig,
  originConfig,
  parseDomain,
} from "../resources/domain.ts";

const FAILED = Symbol("config error");

const parse = <A>(config: Config.Config<A>, env: Record<string, string>) => {
  const exit = Effect.runSyncExit(config.parse(ConfigProvider.fromUnknown(env)));

  return Exit.isSuccess(exit) ? exit.value : FAILED;
};

const DOMAIN = "bye.software";

describe("DOMAIN defaults", () => {
  it("prod uses the bare domain, with no stage suffix", () => {
    expect(domainDefaults({ DOMAIN, STAGE: "prod" })).toEqual({
      APP_ORIGIN: "https://app.bye.software",
      MAIL_RENDER_ORIGIN: "https://mail.bye.software",
      BYE_ONBOARDING_ORIGIN: "https://onboarding.bye.software",
      APP_DOMAIN: "app.bye.software",
      PUBLIC_DOMAIN: "bye.software",
      MAIL_ZONE: "bye.software",
    });
  });

  it("staging gets its own base and never a production host", () => {
    expect(domainDefaults({ DOMAIN, STAGE: "staging" })).toEqual({
      APP_ORIGIN: "https://app.staging.bye.software",
      MAIL_RENDER_ORIGIN: "https://mail.staging.bye.software",
      BYE_ONBOARDING_ORIGIN: "https://onboarding.bye.software",
      APP_DOMAIN: "app.staging.bye.software",
      PUBLIC_DOMAIN: "staging.bye.software",
      // A zone is the registered domain; staging's inbound mail zone is set explicitly.
    });
  });

  it("dev and preview stages get nothing but the shared onboarding origin", () => {
    for (const STAGE of ["dev-abc123def456", "preview-7", undefined])
      expect(domainDefaults({ DOMAIN, STAGE }), String(STAGE)).toEqual({
        BYE_ONBOARDING_ORIGIN: "https://onboarding.bye.software",
      });
  });

  it("values that are set win; empty counts as unset", () => {
    expect(
      domainDefaults({ DOMAIN, STAGE: "prod", APP_ORIGIN: "https://x.test", PUBLIC_DOMAIN: "" }),
    ).toMatchObject({ PUBLIC_DOMAIN: "bye.software" });
    expect(
      domainDefaults({ DOMAIN, STAGE: "prod", APP_ORIGIN: "https://x.test" }),
    ).not.toHaveProperty("APP_ORIGIN");
    expect(domainDefaults({ STAGE: "prod" })).toEqual({});
    expect(domainDefaults({ DOMAIN: " ", STAGE: "prod" })).toEqual({});
  });

  it("refuses anything but a bare hostname", () => {
    expect(parseDomain("Bye.Software")).toBe("bye.software");

    for (const bad of ["https://bye.software", "bye.software/x", "bye.software:443", "localhost"])
      expect(() => parseDomain(bad), bad).toThrow(/bare hostname/);
  });

  it("the stack's Config forms follow the same rules", () => {
    const app = originConfig(Config.String("APP_ORIGIN"), "APP_ORIGIN");
    expect(parse(app, { DOMAIN, STAGE: "prod" })).toBe("https://app.bye.software");
    expect(parse(app, { DOMAIN, STAGE: "staging" })).toBe("https://app.staging.bye.software");
    expect(parse(app, { DOMAIN, STAGE: "dev-abc123def456" })).toBe(FAILED);
    expect(parse(app, { DOMAIN, STAGE: "prod", APP_ORIGIN: "https://x.test" })).toBe(
      "https://x.test",
    );
    expect(parse(app, {})).toBe(FAILED);
    expect(parse(app, { DOMAIN: "https://bye.software", STAGE: "prod" })).toBe(FAILED);

    const pub = hostConfig(Config.String("PUBLIC_DOMAIN"), "PUBLIC_DOMAIN");
    expect(parse(pub, { DOMAIN, STAGE: "prod" })).toBe("bye.software");
    expect(parse(pub, { DOMAIN, STAGE: "staging" })).toBe("staging.bye.software");
    expect(parse(pub, { DOMAIN, STAGE: "dev-abc123def456" })).toBe("");
    expect(parse(pub, { DOMAIN, STAGE: "prod", PUBLIC_DOMAIN: "pub.test" })).toBe("pub.test");
    expect(parse(pub, {})).toBe("");
    const zone = hostConfig(Config.String("MAIL_ZONE"), "MAIL_ZONE");
    expect(parse(zone, { DOMAIN, STAGE: "prod" })).toBe("bye.software");
    expect(parse(zone, { DOMAIN, STAGE: "staging" })).toBe("");
  });

  it("the stack refuses DOMAIN defaults computed for another stage", () => {
    const check = (env: Record<string, string>, stage: string) => {
      const exit = Effect.runSyncExit(domainStageMismatch.parse(ConfigProvider.fromUnknown(env)));

      return Exit.isSuccess(exit) ? exit.value(stage) : "config error";
    };

    expect(check({ DOMAIN, STAGE: "prod" }, "prod")).toBeUndefined();
    expect(check({ DOMAIN, STAGE: "prod" }, "staging")).toMatch(/set STAGE=staging/);
    expect(check({ STAGE: "prod" }, "staging")).toBeUndefined();
  });

  it("check-config accepts DOMAIN in place of the required origins on prod/staging only", () => {
    const names = [
      { name: "APP_ORIGIN", secret: false, optional: false },
      { name: "MAIL_RENDER_ORIGIN", secret: false, optional: false },
    ];

    expect(missingConfig({}, names)).toEqual(["APP_ORIGIN", "MAIL_RENDER_ORIGIN"]);
    expect(missingConfig({ DOMAIN, STAGE: "prod" }, names)).toEqual([]);
    expect(missingConfig({ DOMAIN, STAGE: "dev-abc123def456" }, names)).toEqual([
      "APP_ORIGIN",
      "MAIL_RENDER_ORIGIN",
    ]);
  });

  it("onboarding installs never inherit the operator's DOMAIN", () => {
    const env = childEnv(
      {
        homeDir: "/tmp/h",
        stage: "prod",
        accountId: "a",
        apiToken: "t",
        config: { DOMAIN },
      } as never,
      { DOMAIN },
    );

    expect(env.DOMAIN).toBe("");
    expect(env.PUBLIC_DOMAIN).toBe("");
  });
});
