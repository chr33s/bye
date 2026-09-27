import { api } from "../api.ts";
import { degrade } from "../core/degrade.ts";
import { act, h, text } from "../core/dom.ts";
import { remember, withStepUp } from "../core/state.ts";

// Incoming email for the zone chosen during onboarding (infra/onboarding/spec.md Part B). Optional and
// separate from account setup: nothing here claims mail is ready before the domain is `active`,
// and no MX or Email Routing change happens without the explicit confirmation on the domain page.

export interface InstallationMail {
  readonly zone: string | null;
  readonly automation: "zone-api" | "manual-records";
  /** An owner-entered token limited to the installation zone is stored (never its value). */
  readonly tokenConfigured?: boolean;
  readonly canSetup: boolean;
  readonly domain: { readonly id: string; readonly orgId: string; readonly state: string } | null;
  readonly incomingMail: "active" | "not-set-up";
}

export const installationMail = (signal?: AbortSignal): Promise<InstallationMail | null> =>
  api<InstallationMail>("GET", "/v1/installation/mail", undefined, signal).catch(degrade(null));

const LATER = "mail-setup-later";

/**
 * "Review mail setup": bind the installation zone (no re-entry) to the owner's personal
 * organization (the server's default, where their address on the zone lives), then open its
 * domain page.
 */
const reviewSetup = act("Mail setup", async () => {
  const r = await withStepUp(() =>
    api<{ domainId: string }>("POST", "/v1/domains/from-installation", {}),
  );
  location.hash = `#/domains/${encodeURIComponent(r.domainId)}`;
});

/**
 * The non-blocking "Set up incoming email" card. `dismissible` adds "Do this later" (the banner
 * shown after the first owner signs in); the admin page always keeps the action available.
 */
export const incomingMailCard = (
  info: InstallationMail | null,
  options: { readonly dismissible: boolean; readonly onDismiss?: () => void },
): HTMLElement | null => {
  if (!info?.zone) return null;
  if (info.incomingMail === "active")
    return h(
      "section",
      { class: "card", "aria-label": "Incoming email" },
      h("h2", {}, "Incoming email is ready"),
      h("p", {}, text(info.zone), h("br"), "Receiving mail in Bye"),
    );
  const zone = text(info.zone);
  const continuing = info.domain !== null;
  return h(
    "section",
    { class: "card", "aria-label": "Set up incoming email" },
    h("h2", {}, "Set up incoming email"),
    h("p", { class: "warn" }, "Incoming email not set up"),
    h("p", {}, `Bye is running at ${location.host}.`),
    h(
      "p",
      {},
      `To receive mail at @${zone}, Bye needs to configure Cloudflare Email Routing and your domain's mail DNS.`,
    ),
    h(
      "div",
      { class: "bulk" },
      info.canSetup
        ? continuing
          ? h(
              "a",
              { class: "button", href: `#/domains/${encodeURIComponent(info.domain!.id)}` },
              "Continue mail setup",
            )
          : h("button", { type: "button", onclick: reviewSetup }, "Review mail setup")
        : h("p", { class: "muted" }, "An instance operator can set this up."),
      options.dismissible
        ? h(
            "button",
            {
              type: "button",
              class: "secondary",
              onclick: () => {
                remember.set(LATER, "1");
                options.onDismiss?.();
              },
            },
            "Do this later",
          )
        : null,
    ),
  );
};

/**
 * Shown once the operator is signed in (right after the first owner is created) until they
 * choose "Do this later" or mail is active. Lives outside the main region so views stay intact.
 */
export const showIncomingMailBanner = async (): Promise<void> => {
  if (remember.get(LATER) === "1" || document.getElementById("incoming-mail")) return;
  const info = await installationMail();
  if (!info?.zone || !info.canSetup || info.incomingMail === "active") return;
  const holder = h("div", { id: "incoming-mail" });
  const card = incomingMailCard(info, { dismissible: true, onDismiss: () => holder.remove() });
  if (!card) return;
  holder.append(card);
  document.querySelector("header")?.after(holder);
};

interface Classification {
  readonly kind: "new" | "existing-provider" | "conflicted";
  readonly provider: string | null;
  readonly currentMx: ReadonlyArray<{ readonly content: string; readonly priority?: number }>;
  readonly conflicts: ReadonlyArray<Record<string, unknown>>;
  readonly requiresCutover: boolean;
}

interface SnapshotRecord {
  readonly type: string;
  readonly name: string;
  readonly content: string;
  readonly priority?: number;
}

interface RoutingRuleView {
  readonly enabled: boolean;
  readonly actions: ReadonlyArray<{
    readonly type: string;
    readonly value?: ReadonlyArray<string>;
  }>;
}

/** The mail setup recorded before Bye changed anything (for a manual restore). */
export interface MailSnapshotView {
  readonly mx: ReadonlyArray<SnapshotRecord>;
  readonly spf: ReadonlyArray<SnapshotRecord>;
  readonly dkim: ReadonlyArray<SnapshotRecord>;
  readonly dmarc: ReadonlyArray<SnapshotRecord>;
  readonly routing: {
    readonly enabled: boolean;
    readonly catchAll: RoutingRuleView | null;
    readonly rules: ReadonlyArray<RoutingRuleView>;
  } | null;
}

export interface MailDnsView {
  readonly plan?: ReadonlyArray<Record<string, unknown>>;
  readonly classification?: Classification;
  readonly cutoverPending?: boolean;
  readonly link?: {
    readonly installZoneId: string | null;
    readonly cutoverConfirmedAt: number | null;
    readonly hasSnapshot: boolean;
    readonly writeMode?: "api" | "manual" | null;
    readonly restorePending?: MailSnapshotView | null;
    readonly inboundProbe?: { readonly address: string; readonly receivedAt: number | null } | null;
  };
}

/** Where to create the token, and exactly what to grant (infra/onboarding/spec.md §13). */
export const ZONE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
export const zoneTokenPermissions = (zone: string): ReadonlyArray<string> => [
  "Zone → DNS → Edit",
  "Zone → Email Routing Rules → Edit",
  "Zone → Zone Settings → Edit",
  `Zone Resources: Include → Specific zone → ${zone} (only this zone)`,
];

/**
 * "Let Bye make the changes" (a Cloudflare token limited to this zone) or "I'll add the records
 * myself" (manual records). Shown for the installation's own zone before anything is authorized.
 */
const automationChooser = (
  name: string,
  info: InstallationMail | null,
  reload: () => void,
): HTMLElement | null => {
  if (!info?.zone || info.zone !== name) return null;
  if (info.automation === "zone-api")
    return h(
      "div",
      { class: "card", "aria-label": "How changes are made" },
      h("p", {}, "✓ Bye will make these changes in Cloudflare for you."),
      info.tokenConfigured
        ? h(
            "button",
            {
              type: "button",
              class: "secondary",
              onclick: act(
                "Token removed",
                () => withStepUp(() => api("DELETE", "/v1/installation/mail/token")),
                reload,
              ),
            },
            "Remove the Cloudflare token (I'll add the records myself)",
          )
        : null,
    );
  const token = h("input", {
    type: "password",
    name: "zoneToken",
    autocomplete: "off",
    spellcheck: "false",
    "aria-label": "Cloudflare API token",
  });
  const form = h(
    "form",
    {
      hidden: true,
      onsubmit: act(
        "Cloudflare token connected",
        async () => {
          const value = token.value.trim();
          token.value = "";
          await withStepUp(() => api("POST", "/v1/installation/mail/token", { token: value }));
        },
        reload,
      ),
    },
    h("p", {}, "Create a Cloudflare API token with exactly these permissions:"),
    h(
      "ul",
      {},
      zoneTokenPermissions(name).map((p) => h("li", {}, p)),
    ),
    h(
      "p",
      {},
      h(
        "a",
        { href: ZONE_TOKEN_URL, target: "_blank", rel: "noopener" },
        "Create a token in Cloudflare",
      ),
    ),
    h("label", {}, "Cloudflare API token", token),
    h(
      "p",
      { class: "muted" },
      "Bye checks the token reaches only this domain, stores it encrypted and never shows it again.",
    ),
    h("button", { type: "submit" }, "Connect token"),
  );
  return h(
    "div",
    { class: "card", "aria-label": "How changes are made" },
    h("p", {}, "How should the changes be made?"),
    h(
      "div",
      { class: "bulk" },
      h(
        "button",
        { type: "button", onclick: () => form.removeAttribute("hidden") },
        "Let Bye make the changes",
      ),
      h(
        "button",
        { type: "button", class: "secondary", onclick: () => form.setAttribute("hidden", "") },
        "I'll add the records myself",
      ),
    ),
    form,
  );
};

const LIVE = new Set(["queued", "running", "paused", "waiting", "waitingForPause"]);

const describeRule = (rule: RoutingRuleView | null): string =>
  rule === null
    ? "no catch-all rule"
    : `${rule.enabled ? "enabled" : "disabled"}: ${rule.actions
        .map((a) => (a.value?.length ? `${a.type} to ${a.value.join(", ")}` : a.type))
        .join("; ")}`;

/** The records to put back by hand after a manual-records rollback. */
const restoreList = (snap: MailSnapshotView): ReadonlyArray<string> => [
  ...(snap.mx.length
    ? snap.mx.map((r) => `MX ${r.name} ${r.priority ?? ""} ${r.content}`.replace(/\s+/g, " "))
    : ["MX: none (remove Bye's MX records)"]),
  ...(snap.spf.length ? snap.spf.map((r) => `TXT ${r.name} "${r.content}"`) : ["SPF: none"]),
  ...snap.dkim.map((r) => `TXT ${r.name} "${r.content}"`),
  ...(snap.dmarc.length ? snap.dmarc.map((r) => `TXT ${r.name} "${r.content}"`) : ["DMARC: none"]),
  ...(snap.routing
    ? [
        `Email Routing: ${snap.routing.enabled ? "enabled" : "disabled"}`,
        `Catch-all: ${describeRule(snap.routing.catchAll)}`,
      ]
    : ["Email Routing: not recorded (restore it as you had it)"]),
];

/** Records the customer publishes themselves when Bye has no zone access (manual records). */
const recordsToPublish = (plan: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> =>
  plan.flatMap((op) => {
    const r = (op.record ?? op.to ?? op.desired) as SnapshotRecord | undefined;
    if (!r || op.op === "keep") return [];
    return [
      `${r.type} ${r.name}${r.priority !== undefined ? ` ${r.priority}` : ""} ${r.type === "TXT" ? `"${r.content}"` : r.content}`,
    ];
  });

const PROGRESS: ReadonlyArray<readonly [string, string]> = [
  ["zone-authorized", "Incoming email authorized"],
  ["dns-configured", "MX, SPF, DKIM and DMARC records configured"],
  ["inbound-tested", "Cloudflare Email Routing enabled and incoming delivery verified"],
  ["outbound-tested", "Sender authentication verified"],
];
const ORDER = [
  "requested",
  "ownership-proven",
  "zone-authorized",
  "dns-configured",
  "inbound-tested",
  "outbound-tested",
  "active",
];

const proposal = (plan: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<string> => {
  const has = (purpose: string, ...ops: Array<string>) =>
    plan.some((o) => String(o.purpose).startsWith(purpose) && ops.includes(String(o.op)));
  return [
    "Enable Cloudflare Email Routing",
    "Route incoming mail to Bye",
    has("inbound", "create", "conflict") ? "Update MX records" : null,
    has("spf", "update") ? "Merge Bye into SPF" : has("spf", "create") ? "Add SPF" : null,
    has("dkim", "create") ? "Add Bye DKIM" : null,
    has("dmarc", "keep") ? "Keep your existing DMARC policy" : "Add a DMARC policy",
  ].filter((x): x is string => x !== null);
};

/**
 * The incoming-email section of a domain page: inspect → (cutover confirmation) → apply →
 * verify, with retry and "Restore previous mail setup" when verification fails.
 */
export const incomingMailSection = (
  domain: Record<string, unknown>,
  dns: MailDnsView,
  info: InstallationMail | null,
  reload: () => void,
): HTMLElement => {
  const id = encodeURIComponent(text(domain.id));
  const name = text(domain.name);
  const current = text(domain.state);
  const at = ORDER.indexOf(current);
  const workflow = (domain.workflow as { status?: string } | null)?.status;
  const c = dns.classification;
  const method = info?.automation === "zone-api" ? "delegated-token" : "manual-records";
  const authorize = (confirmCutover: boolean, label: string) =>
    act(
      label,
      () =>
        withStepUp(() =>
          api("POST", `/v1/domains/${id}/authorize-zone`, {
            method,
            ...(confirmCutover ? { confirmCutover: true } : {}),
          }),
        ),
      reload,
    );
  const restore = h(
    "button",
    {
      type: "button",
      class: "danger",
      onclick: act(
        "Restoring previous mail setup",
        () => withStepUp(() => api("POST", `/v1/domains/${id}/rollback`, {})),
        reload,
      ),
    },
    "Restore previous mail setup",
  );
  const restartButton = (label: string) =>
    h(
      "button",
      {
        type: "button",
        onclick: act(
          label,
          () => withStepUp(() => api("POST", `/v1/domains/${id}/retry`, {})),
          reload,
        ),
      },
      label,
    );
  const retry = restartButton("Retry checks");
  const live = workflow !== undefined && LIVE.has(workflow);
  const switchDialog = (provider: string | null) => {
    const dialog = h(
      "div",
      { class: "card", hidden: true, role: "alertdialog", "aria-label": "Switch incoming email" },
      h("h3", {}, "Switch incoming email to Bye?"),
      h("p", {}, `Mail sent to @${name} will begin routing to Bye.`),
      h("p", {}, "Your current provider:", h("br"), text(provider)),
      h("p", {}, "This changes the domain's MX records and Email Routing."),
      h(
        "div",
        { class: "bulk" },
        h(
          "button",
          { type: "button", class: "danger", onclick: authorize(true, "Switching incoming email") },
          "Switch incoming email to Bye",
        ),
        h(
          "button",
          { type: "button", class: "secondary", onclick: () => dialog.setAttribute("hidden", "") },
          "Cancel",
        ),
      ),
    );
    return dialog;
  };

  // After a manual-records rollback the recorded setup stays here until the owner confirms it.
  const pending = dns.link?.restorePending ?? null;
  const restoreCard = pending
    ? h(
        "section",
        { class: "card", "aria-label": "Restore your previous mail setup" },
        h("h2", {}, "Restore your previous mail setup"),
        h(
          "p",
          {},
          "Bye cannot change this domain's DNS itself. Put these records and settings back in Cloudflare:",
        ),
        h(
          "ul",
          {},
          restoreList(pending).map((line) => h("li", {}, h("code", {}, line))),
        ),
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Recorded",
              () => withStepUp(() => api("POST", `/v1/domains/${id}/restore-acknowledged`, {})),
              reload,
            ),
          },
          "I've restored these",
        ),
      )
    : null;
  const withRestore = (section: HTMLElement): HTMLElement =>
    restoreCard ? h("div", {}, restoreCard, section) : section;

  if (current === "active")
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "Incoming email is ready"),
      h("p", {}, name, h("br"), "Receiving mail in Bye"),
    );

  if (at >= ORDER.indexOf("zone-authorized")) {
    const failed = !live;
    const probe = dns.link?.inboundProbe ?? null;
    const confirm = dns.cutoverPending ? switchDialog(c?.provider ?? null) : null;
    return h(
      "section",
      { class: "card", "aria-live": "polite" },
      h(
        "h2",
        {},
        dns.cutoverPending
          ? "Confirm the switch to continue"
          : failed
            ? "Incoming email setup could not be verified."
            : "Setting up incoming email",
      ),
      dns.cutoverPending
        ? h(
            "p",
            { class: "warn" },
            `Incoming mail for ${name} still goes to ${text(c?.provider)}. Setup is held until you confirm the switch.`,
          )
        : null,
      h(
        "ul",
        {},
        PROGRESS.map(([s, label]) => {
          const done = at >= ORDER.indexOf(s);
          const next = !done && at === ORDER.indexOf(s) - 1;
          return h("li", {}, done ? `✓ ${label}` : next ? `• ${label}…` : `  ${label}`);
        }),
      ),
      method === "delegated-token"
        ? h("p", { class: "muted" }, "Bye is making these changes in Cloudflare for you.")
        : null,
      method === "manual-records"
        ? h(
            "div",
            {},
            h(
              "p",
              { class: "muted" },
              "This installation cannot change DNS or Email Routing itself. In Cloudflare, publish these records, then enable Email Routing with a catch-all rule that sends mail to the Bye Worker:",
            ),
            h(
              "ul",
              {},
              recordsToPublish(dns.plan ?? []).map((line) => h("li", {}, h("code", {}, line))),
            ),
            probe
              ? h(
                  "p",
                  {},
                  probe.receivedAt
                    ? "✓ A test message reached Bye."
                    : `Then send a test message from another mailbox to ${probe.address}. Bye marks incoming email ready only once that message arrives.`,
                )
              : null,
          )
        : null,
      h(
        "div",
        { class: "bulk" },
        confirm
          ? h(
              "button",
              { type: "button", onclick: () => confirm.removeAttribute("hidden") },
              "Continue",
            )
          : null,
        retry,
        dns.link?.hasSnapshot ? restore : null,
      ),
      confirm,
    );
  }

  if (current === "requested")
    return h(
      "section",
      { class: "card" },
      h("p", {}, "Prove ownership of the domain first; incoming email setup follows."),
      h("div", { class: "bulk" }, retry),
    );

  // ownership-proven: a restart is always available when no live setup is running.
  const restart = live ? null : restartButton("Restart setup");
  if (!c)
    return withRestore(
      h(
        "section",
        { class: "card" },
        h("p", { class: "warn" }, "Bye could not read the current mail setup for this domain."),
        h(
          "div",
          { class: "bulk" },
          h("button", { type: "button", onclick: reload }, "Try again"),
          restart,
        ),
      ),
    );

  const header = h("h2", {}, `Incoming email for ${name}`);
  const unchanged = h("p", { class: "muted" }, "No changes have been made yet.");

  if (c.kind === "conflicted")
    return withRestore(
      h(
        "section",
        { class: "card" },
        header,
        automationChooser(name, info, reload),
        h(
          "p",
          { class: "bad" },
          "These records must be fixed in Cloudflare before Bye can continue:",
        ),
        h(
          "ul",
          {},
          c.conflicts.map((x) =>
            h(
              "li",
              {},
              `${text(x.purpose)}: ${text((x.existing as Record<string, unknown> | undefined)?.content)}`,
            ),
          ),
        ),
        unchanged,
        h(
          "div",
          { class: "bulk" },
          h("button", { type: "button", onclick: reload }, "Check again"),
        ),
      ),
    );

  if (c.kind === "new")
    return withRestore(
      h(
        "section",
        { class: "card" },
        header,
        h("p", {}, "No existing mail provider detected."),
        automationChooser(name, info, reload),
        h("p", {}, "Bye can configure incoming email automatically."),
        h(
          "div",
          { class: "bulk" },
          h(
            "button",
            { type: "button", onclick: authorize(false, "Enabling incoming email") },
            "Enable incoming email",
          ),
          restart,
        ),
        unchanged,
      ),
    );

  // Existing provider: review first, then a separate explicit cutover confirmation.
  const confirm = switchDialog(c.provider);
  return withRestore(
    h(
      "section",
      { class: "card" },
      header,
      h("p", {}, "Current mail provider", h("br"), h("strong", {}, text(c.provider))),
      automationChooser(name, info, reload),
      h("p", {}, "Bye proposes:"),
      h(
        "ul",
        {},
        proposal(dns.plan ?? []).map((p) => h("li", {}, p)),
      ),
      unchanged,
      h(
        "div",
        { class: "bulk" },
        h(
          "button",
          { type: "button", onclick: () => confirm.removeAttribute("hidden") },
          "Continue",
        ),
        h("a", { class: "button secondary", href: "#/admin" }, "Cancel"),
        restart,
      ),
      confirm,
    ),
  );
};
