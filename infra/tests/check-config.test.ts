import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_PREVIEW_POLICY } from "@bye/platform-cloudflare";
import {
  declaredConfig,
  forbiddenConfig,
  missingConfig,
  missingPreviewAttestation,
  personalMailProblems,
  previewSecretOverreach,
  PROVIDER_PREVIEW_ATTESTATION,
  requiredConfig,
  scanConfig,
  scannerProblems,
  unmappedInCi,
  unsandboxedMail,
  webhookSecretProblems,
} from "../policies/check-config.ts";

const CI = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");
const DRIFT = readFileSync(join(import.meta.dirname, "../../.github/workflows/drift.yml"), "utf8");

describe("deploy config gate (§15.5, §15.8)", () => {
  it("fault and sandbox switches are refused on shared stages but allowed on previews", () => {
    const env = { BYE_FAULT_INGRESS: "throw", MAIL_SANDBOX_DOMAINS: "preview.test" };
    expect(forbiddenConfig({ ...env, STAGE: "prod" })).toEqual([
      "BYE_FAULT_INGRESS",
      "MAIL_SANDBOX_DOMAINS",
    ]);
    expect(forbiddenConfig({ ...env, STAGE: "staging" })).toHaveLength(2);
    expect(forbiddenConfig({ ...env, STAGE: "preview-12" })).toEqual([]);
    expect(forbiddenConfig({ STAGE: "prod", BYE_FAULT_INGRESS: " " })).toEqual([]);
  });

  it("required names come from the stack declarations and missing ones are listed by name only", () => {
    const names = requiredConfig();
    expect(names.length).toBeGreaterThan(0);
    const missing = missingConfig({});
    expect(missing).toEqual(names.map((n) => n.name));
  });

  it("the stack's optional() reads are discovered as optional names", () => {
    expect(scanConfig('const a = (yield* optional("APP_DOMAIN")) || undefined;')).toEqual([
      { name: "APP_DOMAIN", secret: false, optional: true },
    ]);
    const declared = declaredConfig().map((c) => c.name);
    for (const name of [
      "APP_DOMAIN",
      "PUBLIC_DOMAIN",
      "MAIL_ZONE",
      "BYE_MX_CUTOVER",
      "VAPID_PRIVATE_KEY",
      "OPS_TOKEN",
    ])
      expect(declared).toContain(name);
    expect(requiredConfig().map((c) => c.name)).not.toContain("APP_DOMAIN");
  });

  it("every declared name is mapped into the CI deploy environment (none silently off)", () => {
    expect(unmappedInCi(CI)).toEqual([]);
    // The detector itself works: dropping a mapping is reported.
    expect(unmappedInCi(CI.replace(/^\s+MAIL_ZONE:.*$/gm, ""))).toEqual(["MAIL_ZONE"]);
    // Evidence-only switches are never mapped by the pipeline.
    expect(CI).not.toMatch(/^\s+BYE_FAULT_INGRESS:/m);
    // The weekly drift job evaluates the same stack, so it maps the same names.
    expect(unmappedInCi(DRIFT)).toEqual([]);
    expect(DRIFT).not.toMatch(/^\s+BYE_FAULT_INGRESS:/m);
  });

  it("ephemeral stages with a mail credential must have a mail sandbox", () => {
    const creds = { PERSONAL_MAIL_API_KEY: "k" };
    expect(unsandboxedMail({ ...creds, STAGE: "preview-4" })).toEqual(["PERSONAL_MAIL_API_KEY"]);
    expect(
      unsandboxedMail({
        ...creds,
        NEWSLETTER_API_KEY: "s",
        STAGE: "dev-abc123",
        MAIL_SANDBOX_DOMAINS: " ",
      }),
    ).toEqual(["PERSONAL_MAIL_API_KEY", "NEWSLETTER_API_KEY"]);
    expect(
      unsandboxedMail({ ...creds, STAGE: "preview-4", MAIL_SANDBOX_DOMAINS: "sandbox.test" }),
    ).toEqual([]);
    expect(unsandboxedMail({ STAGE: "preview-4" })).toEqual([]);
    // Shared stages never use the sandbox (forbiddenConfig refuses it there).
    expect(unsandboxedMail({ ...creds, STAGE: "prod" })).toEqual([]);
    // CI maps the sandbox into the shared deploy environment used by preview and steady jobs.
    expect(CI).toMatch(/^\s+MAIL_SANDBOX_DOMAINS: \$\{\{ vars\.MAIL_SANDBOX_DOMAINS \}\}/m);
  });

  it("shared stages holding a mail credential need the provider-preview attestation (§10)", () => {
    // The platform policy and the deploy check agree.
    expect(PROVIDER_PREVIEW_POLICY.disableSentEmailPreviews).toBe(true);
    expect(PROVIDER_PREVIEW_ATTESTATION).toEqual({
      name: "PROVIDER_SENT_PREVIEWS",
      value: "disabled",
    });
    const creds = { PERSONAL_MAIL_API_KEY: "k" };
    expect(missingPreviewAttestation({ ...creds, STAGE: "prod" })).toBe(true);
    expect(
      missingPreviewAttestation({ ...creds, STAGE: "staging", PROVIDER_SENT_PREVIEWS: "enabled" }),
    ).toBe(true);
    expect(
      missingPreviewAttestation({ ...creds, STAGE: "prod", PROVIDER_SENT_PREVIEWS: "disabled" }),
    ).toBe(false);
    // No mail credential, or an ephemeral stage (sandboxed instead): nothing to attest.
    expect(missingPreviewAttestation({ STAGE: "prod" })).toBe(false);
    expect(missingPreviewAttestation({ ...creds, STAGE: "preview-3" })).toBe(false);
    expect(CI).toMatch(/^\s+PROVIDER_SENT_PREVIEWS: \$\{\{ vars\.PROVIDER_SENT_PREVIEWS \}\}/m);
  });

  it("every web build step gets the public build inputs (sitekey, origins, stage)", () => {
    for (const workflow of [CI, DRIFT]) {
      expect(workflow).toMatch(/^\s+TURNSTILE_SITEKEY: \$\{\{ vars\.TURNSTILE_SITEKEY \}\}/m);
      for (const name of ["STAGE", "APP_ORIGIN", "MAIL_RENDER_ORIGIN"])
        expect(workflow).toMatch(new RegExp(`^\\s+${name}:`, "m"));
    }
    // The verify job's standalone build step maps them explicitly (it has no deploy env).
    const verifyBuild = CI.slice(CI.indexOf("- name: Build web client"));
    expect(verifyBuild.slice(0, verifyBuild.indexOf("run: pnpm build:web"))).toMatch(
      /TURNSTILE_SITEKEY:[\s\S]*APP_ORIGIN:[\s\S]*MAIL_RENDER_ORIGIN:/,
    );
  });

  it("webhook secrets: SEND_EVENTS_WEBHOOK_SECRET is declared, CI-mapped and private; short values are refused", () => {
    const names = declaredConfig().map((c) => c.name);
    expect(names).toContain("SEND_EVENTS_WEBHOOK_SECRET");
    expect(CI).toMatch(
      /^\s+SEND_EVENTS_WEBHOOK_SECRET: \$\{\{ secrets\.SEND_EVENTS_WEBHOOK_SECRET \}\}/m,
    );
    expect(webhookSecretProblems({})).toEqual([]);
    expect(
      webhookSecretProblems({
        BILLING_WEBHOOK_SECRET: "b".repeat(32),
        SEND_EVENTS_WEBHOOK_SECRET: "s".repeat(40),
      }),
    ).toEqual([]);
    expect(webhookSecretProblems({ SEND_EVENTS_WEBHOOK_SECRET: "short" })).toEqual([
      "SEND_EVENTS_WEBHOOK_SECRET is shorter than 32 characters",
    ]);
    expect(webhookSecretProblems({ BILLING_WEBHOOK_SECRET: "billing" })).toEqual([
      "BILLING_WEBHOOK_SECRET is shorter than 32 characters",
    ]);
  });

  it("personal mail: key and endpoint are set together, and the endpoint is a real https host", () => {
    expect(personalMailProblems({})).toEqual([]);
    expect(
      personalMailProblems({
        PERSONAL_MAIL_API_KEY: "k",
        PERSONAL_MAIL_ENDPOINT: "https://api.mailprovider.net/v1/messages",
      }),
    ).toEqual([]);
    expect(personalMailProblems({ PERSONAL_MAIL_API_KEY: "k" })).toEqual([
      "PERSONAL_MAIL_API_KEY is set but PERSONAL_MAIL_ENDPOINT is empty",
    ]);
    expect(
      personalMailProblems({ PERSONAL_MAIL_API_KEY: "k", PERSONAL_MAIL_ENDPOINT: " " }),
    ).toEqual(["PERSONAL_MAIL_API_KEY is set but PERSONAL_MAIL_ENDPOINT is empty"]);
    expect(personalMailProblems({ PERSONAL_MAIL_ENDPOINT: "https://api.provider.net/v1" })).toEqual(
      ["PERSONAL_MAIL_ENDPOINT is set but PERSONAL_MAIL_API_KEY is empty"],
    );
    for (const endpoint of [
      "https://mail-provider.invalid/v1/messages",
      "https://mail.example.com/v1",
      "https://relay.test/v1",
      "https://localhost/v1",
    ])
      expect(
        personalMailProblems({ PERSONAL_MAIL_API_KEY: "k", PERSONAL_MAIL_ENDPOINT: endpoint }),
        endpoint,
      ).toEqual(["PERSONAL_MAIL_ENDPOINT names a placeholder host"]);
    expect(
      personalMailProblems({ PERSONAL_MAIL_API_KEY: "k", PERSONAL_MAIL_ENDPOINT: "http://a.net/" }),
    ).toEqual(["PERSONAL_MAIL_ENDPOINT must be an https URL"]);
    // Both are optional stack names, and CI maps both.
    const declared = declaredConfig();
    expect(declared.find((c) => c.name === "PERSONAL_MAIL_API_KEY")).toMatchObject({
      secret: true,
      optional: true,
    });
    expect(declared.map((c) => c.name)).toContain("PERSONAL_MAIL_ENDPOINT");
    expect(CI).toMatch(/^\s+PERSONAL_MAIL_ENDPOINT: \$\{\{ vars\.PERSONAL_MAIL_ENDPOINT \}\}/m);
  });

  it("scanner signature source is validated before a plan and mapped into CI", () => {
    expect(scannerProblems({})).toEqual([]);
    expect(scannerProblems({ SCANNER_SIGNATURES: "" })).toEqual([]);
    expect(
      scannerProblems({ SCANNER_SIGNATURES: "baked", SCANNER_IMAGE: "ghcr.io/x:latest" }),
    ).toHaveLength(1);
    expect(
      scannerProblems({
        SCANNER_SIGNATURES: "baked",
        SCANNER_IMAGE: `ghcr.io/x/scanner@sha256:${"a".repeat(64)}`,
      }),
    ).toEqual([]);
    const declared = declaredConfig().map((c) => c.name);
    expect(declared).toContain("SCANNER_SIGNATURES");
    expect(declared).toContain("SCANNER_IMAGE");
    expect(unmappedInCi(CI)).not.toContain("SCANNER_IMAGE");
  });

  it("state credentials are tiered: prod state only in prod jobs; previews never share hosts", () => {
    const job = (name: string) =>
      new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  [a-z-]+:\\n|$)`).exec(CI)?.[0] ?? "";
    // The shared deploy env (preview/steady, where PR code runs) never references prod secrets.
    expect(job("preview")).not.toMatch(/(secrets|vars)\.PROD_/);
    expect(job("steady")).not.toMatch(/(secrets|vars)\.PROD_/);
    // Release jobs pick the prod state backend only for prod, and never fall back to nonprod.
    expect(CI).toMatch(
      /BYE_STATE_TOKEN: \$\{\{ inputs\.stage == 'prod' && secrets\.PROD_BYE_STATE_TOKEN \|\| inputs\.stage != 'prod' && secrets\.BYE_STATE_TOKEN \|\| '' \}\}/,
    );
    // Previews derive per-PR hosts; the unused mappings are gone.
    expect(job("preview")).toMatch(/APP_DOMAIN: .*github\.event\.pull_request\.number/);
    expect(job("preview")).toMatch(/APP_ORIGIN: .*github\.event\.pull_request\.number/);
    expect(CI).not.toMatch(/PUBLIC_ORIGIN|BYE_STATE_WORKER_SHA256|APP_HOST_PREFIX/);
    // Every plan/deploy path builds the MIME container bundle first.
    expect(CI).not.toMatch(/pnpm build:web &&/);
    expect(CI).toMatch(
      /pnpm build:deploy && \$EGRESS node --experimental-strip-types infra\/policies\/plan-export\.ts/,
    );
  });

  it("PR-executed preview jobs resolve only the secrets a preview needs", () => {
    const job = (name: string) =>
      new RegExp(`\\n  ${name}:[\\s\\S]*?(?=\\n  [a-z-]+:\\n|$)`).exec(CI)?.[0] ?? "";
    expect(job("preview")).toContain("SESSION_KEY");
    expect(previewSecretOverreach(job("preview"))).toEqual([]);
    // preview-destroy reuses the same env anchor.
    expect(job("preview-destroy")).toMatch(/env: \*deploy-env/);
    // Every required secret still reaches the preview (check-config must pass there).
    for (const c of requiredConfig().filter((c) => c.secret))
      expect(job("preview")).toContain(`${c.name}: \${{ secrets.${c.name} }}`);
    // The blanked names stay mapped (explicitly empty), so `unmappedInCi` holds.
    for (const name of ["CF_DNS_API_TOKEN", "ARC_SIGNING_KEY", "BILLING_API_KEY", "OPS_TOKEN"])
      expect(job("preview")).toMatch(new RegExp(`\\n\\s+${name}: ""\\n`));
    // Detector: a regression that maps a DNS token into the preview is reported.
    expect(
      previewSecretOverreach(
        `${job("preview")}\n      CF_DNS_API_TOKEN: \${{ secrets.CF_DNS_API_TOKEN }}`,
      ),
    ).toEqual(["CF_DNS_API_TOKEN"]);
  });

  it("every action is pinned to a full commit SHA", () => {
    const wf = [
      CI,
      DRIFT,
      readFileSync(join(import.meta.dirname, "../../.github/workflows/scanner-image.yml"), "utf8"),
    ];
    for (const text of wf)
      for (const [, ref] of text.matchAll(/uses:\s*(\S+)/g))
        expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });
});
