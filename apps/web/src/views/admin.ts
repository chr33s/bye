import { api, list, query } from "../api.ts";
import { degrade } from "../core/degrade.ts";
import { act, field, formatDate, formatSize, h, section, show, table, text } from "../core/dom.ts";
import { remember, state, withStepUp } from "../core/state.ts";
import {
  incomingMailCard,
  incomingMailSection,
  installationMail,
  type MailDnsView,
} from "./incoming-mail.ts";

// Account, team and billing administration (O01, O02, A01, A02, A04). Consequential actions go
// through `withStepUp`, so an expired step-up prompts a passkey confirmation and retries once.

const orgOf = (params: URLSearchParams): string =>
  params.get("org") ?? remember.get("org") ?? state.me?.organizationIds?.[0] ?? "";

export const renderAdmin = async (params: URLSearchParams, signal: AbortSignal): Promise<void> => {
  const orgId = orgOf(params);
  if (orgId) remember.set("org", orgId);
  const reload = () => void renderAdmin(params, signal);
  const [org, members, seats, audit, domains, billing, mail] = await Promise.all([
    orgId
      ? api<Record<string, unknown>>("GET", `/v1/orgs/${orgId}`, undefined, signal).catch(
          degrade(null),
        )
      : null,
    orgId
      ? list<Record<string, unknown>>(`/v1/orgs/${orgId}/members`, signal).catch(degrade([]))
      : [],
    orgId
      ? api<{ limit?: number; used?: number; entitled?: number | null }>(
          "GET",
          `/v1/orgs/${orgId}/seats`,
          undefined,
          signal,
        ).catch(degrade(null))
      : null,
    orgId
      ? list<Record<string, unknown>>(
          `/v1/orgs/${orgId}/audit${query({ limit: 50 })}`,
          signal,
        ).catch(degrade([]))
      : [],
    orgId
      ? list<Record<string, unknown>>(`/v1/orgs/${orgId}/domains`, signal).catch(degrade([]))
      : [],
    api<Record<string, unknown>>("GET", `/v1/billing${query({ orgId })}`, undefined, signal).catch(
      degrade(null),
    ),
    installationMail(signal),
  ]);
  const orgPicker = h(
    "select",
    {
      "aria-label": "Organization",
      onchange: (e: Event) =>
        (location.hash = `#/admin${query({ org: (e.target as HTMLSelectElement).value })}`),
    },
    (state.me?.organizationIds ?? []).map((id) =>
      h(
        "option",
        { value: id, selected: id === orgId },
        id === orgId && org?.name ? text(org.name) : id,
      ),
    ),
  );
  const inviteAddress = h("input", { type: "email", "aria-label": "Invite address" });
  const inviteRole = h(
    "select",
    { "aria-label": "Role" },
    h("option", { value: "member" }, "Member"),
    h("option", { value: "admin" }, "Admin"),
  );
  const seatLimit = h("input", {
    type: "number",
    min: "1",
    value: String(seats?.limit ?? 1),
    "aria-label": "Seat limit",
  });
  const newOrgName = h("input", { "aria-label": "New organization name" });
  const newOrgKind = h(
    "select",
    { "aria-label": "Kind" },
    h("option", { value: "domain" }, "Team (custom domain)"),
    h("option", { value: "family" }, "Family"),
  );
  const domainName = h("input", { placeholder: "example.com", "aria-label": "Domain name" });
  const plan = h(
    "select",
    { "aria-label": "Plan" },
    ["personal", "domain", "family"].map((p) =>
      h("option", { value: p, selected: billing?.plan === p }, p),
    ),
  );
  const interval = h(
    "select",
    { "aria-label": "Billing interval" },
    h("option", { value: "year" }, "Yearly"),
    h("option", { value: "month" }, "Monthly"),
  );
  const inviteToken = h("input", { "aria-label": "Invitation code" });
  const isAdmin = members.some(
    (m) => m.userId === state.me?.userId && (m.role === "owner" || m.role === "admin"),
  );

  show(
    section(
      "admin-title",
      "Account, team and billing",
      incomingMailCard(mail, { dismissible: false }),
      h(
        "div",
        { class: "bulk" },
        orgPicker,
        h("a", { href: "#/exports", class: "button" }, "Export your data"),
        h("a", { href: "#/account/close", class: "button danger" }, "Close account"),
      ),
      h("h2", {}, "Billing"),
      billing
        ? h(
            "div",
            {},
            h(
              "p",
              {},
              `Plan: ${text(billing.plan ?? "none")} · Status: ${text(billing.status ?? "—")}${billing.trialEndsAt ? ` · Trial ends ${formatDate(billing.trialEndsAt as number)}` : ""}${billing.periodEndsAt ? ` · Renews ${formatDate(billing.periodEndsAt as number)}` : ""}`,
            ),
            h(
              "div",
              { class: "bulk" },
              plan,
              interval,
              h(
                "button",
                {
                  type: "button",
                  onclick: act("Opening checkout", async () => {
                    const r = await withStepUp(() =>
                      api<{ url: string }>("POST", "/v1/billing/checkout", {
                        orgId,
                        plan: plan.value,
                        interval: interval.value,
                      }),
                    );
                    window.location.assign(r.url);
                  }),
                },
                "Checkout",
              ),
              h(
                "button",
                {
                  type: "button",
                  onclick: act(
                    "Plan changed",
                    () =>
                      withStepUp(() =>
                        api("POST", "/v1/billing/plan", {
                          orgId,
                          plan: plan.value,
                          interval: interval.value,
                        }),
                      ),
                    reload,
                  ),
                },
                "Change plan",
              ),
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Cancellation scheduled",
                    () => withStepUp(() => api("POST", "/v1/billing/cancel", { orgId })),
                    reload,
                  ),
                },
                "Cancel subscription",
              ),
            ),
            h("p", {}, h("a", { href: "#/referral" }, "Invite friends (referral)")),
          )
        : h("p", { class: "empty" }, "No billing information."),
      h("h2", {}, "Team"),
      seats
        ? h(
            "p",
            {},
            `Seats: ${seats.used ?? 0} used of ${seats.limit ?? 0}${seats.entitled ? ` (plan allows ${seats.entitled})` : ""}`,
          )
        : null,
      table(
        "Members",
        members,
        [
          ["Member", (m) => text(m.displayName || m.address || m.userId)],
          [
            "Role",
            (m) =>
              isAdmin && m.userId !== state.me?.userId
                ? h(
                    "select",
                    {
                      "aria-label": `Role for ${text(m.address)}`,
                      onchange: (e: Event) =>
                        void act(
                          "Role changed",
                          () =>
                            withStepUp(() =>
                              api(
                                "PATCH",
                                `/v1/orgs/${orgId}/members/${encodeURIComponent(text(m.userId))}`,
                                { role: (e.target as HTMLSelectElement).value },
                              ),
                            ),
                          reload,
                        )(),
                    },
                    ["member", "admin", "owner"].map((r) =>
                      h("option", { value: r, selected: m.role === r }, r),
                    ),
                  )
                : text(m.role),
          ],
          ["Status", (m) => text(m.status)],
          [
            "",
            (m) =>
              isAdmin && m.userId !== state.me?.userId
                ? h(
                    "span",
                    {},
                    m.status === "suspended"
                      ? h(
                          "button",
                          {
                            type: "button",
                            onclick: act(
                              "Reactivated",
                              () =>
                                withStepUp(() =>
                                  api(
                                    "POST",
                                    `/v1/orgs/${orgId}/members/${encodeURIComponent(text(m.userId))}/reactivate`,
                                    {},
                                  ),
                                ),
                              reload,
                            ),
                          },
                          "Reactivate",
                        )
                      : h(
                          "button",
                          {
                            type: "button",
                            onclick: act(
                              "Suspended",
                              () =>
                                withStepUp(() =>
                                  api(
                                    "POST",
                                    `/v1/orgs/${orgId}/members/${encodeURIComponent(text(m.userId))}/suspend`,
                                    {},
                                  ),
                                ),
                              reload,
                            ),
                          },
                          "Suspend",
                        ),
                    h(
                      "button",
                      {
                        type: "button",
                        class: "danger",
                        onclick: act(
                          "Removed",
                          () =>
                            withStepUp(() =>
                              api(
                                "DELETE",
                                `/v1/orgs/${orgId}/members/${encodeURIComponent(text(m.userId))}`,
                              ),
                            ),
                          reload,
                        ),
                      },
                      "Remove",
                    ),
                  )
                : "",
          ],
        ],
        "No members.",
      ),
      isAdmin
        ? h(
            "div",
            {},
            h(
              "form",
              {
                class: "bulk",
                onsubmit: act(
                  "Invitation sent",
                  () =>
                    withStepUp(() =>
                      api("POST", `/v1/orgs/${orgId}/invitations`, {
                        address: inviteAddress.value,
                        role: inviteRole.value,
                      }),
                    ),
                  reload,
                ),
              },
              inviteAddress,
              inviteRole,
              h("button", { type: "submit" }, "Invite"),
            ),
            h(
              "form",
              {
                class: "bulk",
                onsubmit: act(
                  "Seats updated",
                  () =>
                    withStepUp(() =>
                      api("PUT", `/v1/orgs/${orgId}/seats`, { limit: Number(seatLimit.value) }),
                    ),
                  reload,
                ),
              },
              field("Seat limit", seatLimit),
              h("button", { type: "submit" }, "Save"),
            ),
          )
        : null,
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Invitation accepted",
            () => api("POST", "/v1/invitations/accept", { token: inviteToken.value }),
            () => (location.hash = "#/admin"),
          ),
        },
        field("Have an invitation code?", inviteToken),
        h("button", { type: "submit" }, "Join"),
      ),
      h("h2", {}, "Custom domains"),
      table(
        "Domains",
        domains,
        [
          [
            "Domain",
            (d) => h("a", { href: `#/domains/${encodeURIComponent(text(d.id))}` }, text(d.name)),
          ],
          ["State", (d) => text(d.state)],
          ["Updated", (d) => formatDate(d.updatedAt as number)],
        ],
        "No custom domains.",
      ),
      isAdmin
        ? h(
            "form",
            {
              class: "bulk",
              onsubmit: act(
                "Domain requested",
                () =>
                  withStepUp(() => api("POST", "/v1/domains", { orgId, name: domainName.value })),
                reload,
              ),
            },
            domainName,
            h("button", { type: "submit" }, "Add domain"),
          )
        : null,
      isAdmin
        ? h(
            "details",
            {},
            h("summary", {}, "Audit log"),
            table(
              "Audit log",
              audit,
              [
                ["When", (a) => formatDate((a.createdAt ?? a.created_at) as number)],
                ["Who", (a) => text(a.actorId ?? a.actor_id)],
                ["Action", (a) => text(a.action)],
                ["Target", (a) => text(a.target)],
              ],
              "No entries.",
            ),
          )
        : null,
      h("h2", {}, "New organization"),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Organization created",
            () =>
              withStepUp(() =>
                api<{ id?: string; orgId?: string }>("POST", "/v1/orgs", {
                  name: newOrgName.value,
                  kind: newOrgKind.value,
                }),
              ),
            () => (state.me = null),
          ),
        },
        newOrgName,
        newOrgKind,
        h("button", { type: "submit" }, "Create"),
      ),
    ),
  );
};

interface DnsView extends MailDnsView {
  readonly plan?: ReadonlyArray<Record<string, unknown>>;
  readonly operations?: ReadonlyArray<Record<string, unknown>>;
  readonly diagnostics?: unknown;
}

/** Domain onboarding (O01): state, diagnostics, DNS preview, settings, aliases, removal. */
export const renderDomain = async (domainId: string, signal: AbortSignal): Promise<void> => {
  const reload = () => void renderDomain(domainId, signal);
  const [domain, dns, aliases, mail] = await Promise.all([
    api<Record<string, unknown>>(
      "GET",
      `/v1/domains/${encodeURIComponent(domainId)}`,
      undefined,
      signal,
    ),
    api<DnsView>("GET", `/v1/domains/${encodeURIComponent(domainId)}/dns`, undefined, signal).catch(
      (): DnsView => ({}),
    ),
    list<Record<string, unknown>>(
      `/v1/domains/${encodeURIComponent(domainId)}/aliases`,
      signal,
    ).catch(degrade([])),
    installationMail(signal),
  ]);
  const localPart = h("input", { "aria-label": "Alias local part", placeholder: "sales" });
  const mailboxId = h("input", {
    "aria-label": "Deliver to mailbox ID",
    value: state.mailboxId ?? "",
  });
  const plus = h("input", {
    type: "checkbox",
    checked: Boolean(domain.plusAddressing ?? domain.plus_addressing),
  });
  const operations = dns.operations ?? dns.plan ?? [];
  show(
    section(
      "domain-title",
      text(domain.name),
      h("p", {}, `State: ${text(domain.state)}`),
      incomingMailSection(domain, dns, mail, reload),
      domain.verificationToken
        ? h(
            "p",
            {},
            "Prove ownership by adding a TXT record: ",
            h(
              "code",
              {},
              `_bye-verification.${text(domain.name)}  TXT  ${text(domain.verificationToken)}`,
            ),
          )
        : null,
      h("h2", {}, "DNS changes (preview — nothing changes until you authorize)"),
      table(
        "DNS plan",
        operations as Array<Record<string, unknown>>,
        [
          ["Action", (o) => text(o.action ?? o.op)],
          ["Type", (o) => text((o.record as Record<string, unknown> | undefined)?.type ?? o.type)],
          ["Name", (o) => text((o.record as Record<string, unknown> | undefined)?.name ?? o.name)],
          [
            "Value",
            (o) => text((o.record as Record<string, unknown> | undefined)?.content ?? o.content),
          ],
        ],
        "No DNS changes needed.",
      ),
      dns.diagnostics
        ? h(
            "details",
            {},
            h("summary", {}, "Diagnostics"),
            h("pre", {}, JSON.stringify(dns.diagnostics, null, 2)),
          )
        : null,
      h(
        "div",
        { class: "bulk" },
        h("label", {}, plus, " Plus-addressing"),
        h(
          "button",
          {
            type: "button",
            onclick: act(
              "Settings saved",
              () =>
                withStepUp(() =>
                  api("PATCH", `/v1/domains/${encodeURIComponent(domainId)}`, {
                    plusAddressing: plus.checked,
                  }),
                ),
              reload,
            ),
          },
          "Save settings",
        ),
      ),
      h("h2", {}, "Addresses"),
      table(
        "Aliases",
        aliases,
        [
          ["Address", (a) => text(a.address)],
          ["Mailbox", (a) => text(a.mailboxId ?? a.mailbox_id)],
          [
            "",
            (a) =>
              h(
                "button",
                {
                  type: "button",
                  class: "danger",
                  onclick: act(
                    "Alias removed",
                    () =>
                      withStepUp(() =>
                        api(
                          "DELETE",
                          `/v1/domains/${encodeURIComponent(domainId)}/aliases/${encodeURIComponent(text(a.address))}`,
                        ),
                      ),
                    reload,
                  ),
                },
                "Remove",
              ),
          ],
        ],
        "No aliases.",
      ),
      h(
        "form",
        {
          class: "bulk",
          onsubmit: act(
            "Alias added",
            () =>
              withStepUp(() =>
                api("POST", `/v1/domains/${encodeURIComponent(domainId)}/aliases`, {
                  localPart: localPart.value,
                  mailboxId: mailboxId.value,
                }),
              ),
            reload,
          ),
        },
        localPart,
        mailboxId,
        h("button", { type: "submit" }, "Add alias"),
      ),
      h("h2", {}, "Remove domain"),
      h(
        "p",
        { class: "muted" },
        "Removing stops delivery for its addresses. Existing DNS records are not deleted.",
      ),
      h(
        "button",
        {
          type: "button",
          class: "danger",
          onclick: act(
            "Domain removed",
            () => withStepUp(() => api("DELETE", `/v1/domains/${encodeURIComponent(domainId)}`)),
            () => (location.hash = "#/admin"),
          ),
        },
        "Remove domain",
      ),
    ),
  );
};

/** Exports (A04): start, watch status, download files through signed expiring links. */
export const renderExports = async (
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<void> => {
  const exportId = params.get("id") ?? remember.get("exportId");
  const status = exportId
    ? await api<{
        status?: string;
        files?: ReadonlyArray<{ name: string; size: number; url: string; expiresAt: number }>;
      }>("GET", `/v1/exports/${encodeURIComponent(exportId)}`, undefined, signal).catch(
        degrade(null),
      )
    : null;
  show(
    section(
      "exports-title",
      "Export your data",
      h(
        "p",
        {},
        "Exports include your mail (MBOX), contacts (vCard), calendars (ICS) and notes, clips and settings (JSON).",
      ),
      h(
        "button",
        {
          type: "button",
          onclick: act("Export started", async () => {
            const r = await api<{ exportId: string }>("POST", "/v1/exports", {});
            remember.set("exportId", r.exportId);
            location.hash = `#/exports${query({ id: r.exportId })}`;
          }),
        },
        "Start a new export",
      ),
      status
        ? h(
            "div",
            {},
            h(
              "p",
              {},
              `Status: ${text(status.status ?? "queued")}`,
              " ",
              h(
                "a",
                { href: `#/exports${query({ id: exportId ?? "" })}`, class: "button" },
                "Refresh",
              ),
            ),
            table(
              "Files",
              status.files ?? [],
              [
                [
                  "File",
                  (f) => h("a", { href: text(f.url), download: text(f.name) }, text(f.name)),
                ],
                ["Size", (f) => formatSize(Number(f.size))],
                ["Link expires", (f) => formatDate(f.expiresAt)],
              ],
              "Files will appear here when the export finishes.",
            ),
          )
        : null,
    ),
  );
};

/** Account closure (A04): terms from the entitlement, explicit address confirmation, optional forwarding. */
export const renderClose = async (signal: AbortSignal): Promise<void> => {
  const terms = await api<Record<string, unknown>>(
    "GET",
    "/v1/account/closure-terms",
    undefined,
    signal,
  ).catch(degrade({} as Record<string, unknown>));
  const confirm = h("input", {
    type: "email",
    required: true,
    "aria-label": "Type your address to confirm",
  });
  const forwardTo = h("input", {
    type: "email",
    "aria-label": "Forward future mail to (optional)",
  });
  show(
    section(
      "close-title",
      "Close account",
      h(
        "p",
        {},
        `Your address stays reserved for ${text(terms.reserveAddressDays ?? "—")} days${terms.forwardingDays ? ` and mail can be forwarded for ${text(terms.forwardingDays)} days` : ""}. Export your data first — closure cannot be undone.`,
      ),
      h(
        "form",
        {
          class: "compose",
          onsubmit: act(
            "Account closed",
            () =>
              withStepUp(() =>
                api("POST", "/v1/account/close", {
                  confirmAddress: confirm.value,
                  ...(forwardTo.value ? { forwardTo: forwardTo.value } : {}),
                }),
              ),
            () => (location.hash = "#/"),
          ),
        },
        field("Your address", confirm),
        field("Forward to (verified by email)", forwardTo),
        h("button", { type: "submit", class: "danger" }, "Close my account"),
      ),
    ),
  );
};

export const renderReferral = async (signal: AbortSignal): Promise<void> => {
  const r = await api<Record<string, unknown>>("GET", "/v1/referral", undefined, signal).catch(
    degrade({} as Record<string, unknown>),
  );
  show(
    section(
      "referral-title",
      "Invite friends",
      r.code
        ? h("p", {}, "Your referral code: ", h("code", {}, text(r.code)))
        : h("p", { class: "empty" }, "Referrals aren't available on this plan."),
      r.credits !== undefined ? h("p", {}, `Credits earned: ${text(r.credits)}`) : null,
    ),
  );
};
