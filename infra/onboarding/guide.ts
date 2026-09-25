// Manual domain and mail guide (spec.md §15.11 step 6). Guide-only in v1: onboarding executes
// none of these steps, whatever the operator confirms, and skipping the guide never affects
// deployment success. App/public domains are kept apart from the mail cutover, which is a
// deliberate operator action with its own checks and rollback (spec.md §15.4, RUNBOOK "MX cutover").

export interface GuideSection {
  readonly id: "domains" | "mail-cutover";
  readonly title: string;
  readonly summary: string;
  readonly before: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
  readonly checks: ReadonlyArray<string>;
  readonly rollback: ReadonlyArray<string>;
}

export interface ManualGuide {
  readonly notice: string;
  readonly sections: ReadonlyArray<GuideSection>;
}

export const manualGuide = (install: {
  readonly stage: string;
  readonly appUrl: string | null;
}): ManualGuide => ({
  notice:
    "Bye onboarding does not change DNS, MX, Email Routing or catch-all routing, even if you confirm. Every step below is yours to perform in your own Cloudflare account, when you choose.",
  sections: [
    {
      id: "domains",
      title: "Custom app and public domains (optional)",
      summary: `Your instance works now at ${install.appUrl ?? "its workers.dev address"}. A custom domain changes the address people and apps use; it does not affect mail.`,
      before: [
        "The zone for the domain is active in the same Cloudflare account.",
        'You have a deployment token or CI environment with Workers Routes Write on that zone only (infra/RUNBOOK.md, "Cloudflare deployment token").',
        "Native apps saved the workers.dev address; they will need to add the new address as a separate instance.",
      ],
      steps: [
        `Set APP_DOMAIN (and PUBLIC_DOMAIN for published sites) for stage ${install.stage}, leave MAIL_RENDER_ORIGIN on the RenderOrigin address (or another hostname that is not the app's), and keep BYE_WORKERS_DEV_NAME unchanged: it fixes the Worker names, and changing or removing it replaces the Workers and their Durable Object data.`,
        "Run STAGE=<stage> pnpm deploy:plan, then pnpm check:plan on the exported plan. Stop on any replace or delete of a persistent resource.",
        "Deploy through your reviewed pipeline, not through onboarding.",
      ],
      checks: [
        "https://<app domain>/.well-known/bye-instance returns baseUrl equal to the new origin.",
        "infra/probes/run.ts passes against the new origin.",
        "Sign-in works from a fresh browser and a native app added with the new address.",
      ],
      rollback: [
        "Redeploy the previous configuration; the workers.dev address keeps working until you disable it.",
      ],
    },
    {
      id: "mail-cutover",
      title: "Mail cutover (MX and Email Routing)",
      summary:
        "Receiving mail at your domain replaces its current MX service. Deployment health does not mean inbound mail is ready.",
      before: [
        "Record the zone's current MX, SPF, DKIM and DMARC records and any existing Email Routing rules, and keep them.",
        "Pick a low-traffic window and lower MX TTLs a day ahead.",
        "Create the mailbox accounts and aliases that must receive mail before switching.",
        "Previews and dev stages never receive production mail.",
      ],
      steps: [
        "Review the proposed MX/routing change against the recorded current state.",
        "Enable Email Routing for the zone with a catch-all to the Bye MailCore Worker (BYE_MX_CUTOVER=approved with MAIL_ZONE, through a reviewed plan), or in the dashboard.",
        "Publish SPF, DKIM and DMARC for the sending setup you have approved.",
      ],
      checks: [
        "Send from an external provider to a real alias; it appears in the Bye mailbox.",
        "Mail to an unknown recipient is rejected, not accepted and lost.",
        "Mail sent during the cutover window is accounted for at the old or the new service.",
      ],
      rollback: [
        "Restore the recorded MX and routing configuration.",
        "Keep Bye running: mail it already accepted stays retrievable.",
      ],
    },
  ],
});
