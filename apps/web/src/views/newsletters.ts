import { api } from "../api.ts";
import { act, field, formatDate, h, section, show } from "../core/dom.ts";
import { withStepUp } from "../core/state.ts";

// Newsletters (infra/onboarding/spec.md §19–§20). Configuration is absent from onboarding: the first time
// an operator opens this view on an unconfigured instance, it asks for one Resend API key; Bye
// validates it, creates the webhook itself and stores both credentials sealed. The key is
// write-only: nothing here ever reads it back. Qualification is a release gate no key overrides.

export interface NewsletterConfigView {
  readonly provider: "resend";
  readonly status: "unconfigured" | "ready" | "blocked" | "needs-attention";
  readonly qualified: boolean;
  readonly canConfigure: boolean;
  readonly configuredAt?: number;
  readonly detail?: string;
}

export const RESEND_API_KEYS_URL = "https://resend.com/api-keys";

const reload = () => window.dispatchEvent(new HashChangeEvent("hashchange"));

/**
 * The operator's one-field setup form. With stored credentials that can no longer be used
 * (`needs-attention` with a configuration date) it is the repair form: the same single key.
 */
const setupForm = (config: NewsletterConfigView): HTMLElement => {
  const repair = config.status === "needs-attention" && config.configuredAt !== undefined;
  const key = h("input", {
    type: "password",
    name: "apiKey",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "re_…",
    required: true,
  });
  return section(
    "newsletters-title",
    repair ? "Reconnect newsletters" : "Set up newsletters",
    h("p", {}, "Bye uses Resend to send newsletters."),
    repair
      ? h(
          "p",
          {},
          "The stored Resend connection can no longer be used. Enter a Resend API key to reconnect. Newsletter work tied to the previous connection stays held for review; it is not moved to the new one.",
        )
      : null,
    h(
      "p",
      {},
      "Create a Resend API key with the access required for contacts, broadcasts and webhook management. A sending-only key is not enough.",
    ),
    config.status === "needs-attention" && config.detail
      ? h("p", { role: "alert" }, config.detail)
      : null,
    h(
      "form",
      {
        class: "bulk",
        onsubmit: act(
          repair ? "Reconnect Resend" : "Connect Resend",
          async () => {
            const apiKey = key.value.trim();
            key.value = "";
            await withStepUp(() =>
              api("POST", "/v1/newsletter/config", { provider: "resend", apiKey }),
            );
          },
          reload,
        ),
      },
      field("Resend API key", key),
      h("button", { type: "submit" }, repair ? "Reconnect Resend" : "Connect Resend"),
    ),
    h(
      "p",
      {},
      h(
        "a",
        { href: RESEND_API_KEYS_URL, target: "_blank", rel: "noopener noreferrer" },
        "Open Resend API Keys",
      ),
    ),
  );
};

/** Which screen the first-use gate shows (pure, for tests). */
export const newsletterGate = (
  config: NewsletterConfigView,
): "open" | "setup" | "not-configured" | "unavailable" => {
  if (config.status === "ready") return "open";
  if (config.status === "blocked" || !config.qualified) return "unavailable";
  return config.canConfigure ? "setup" : "not-configured";
};

export const renderNewsletters = async (signal: AbortSignal): Promise<void> => {
  const config = await api<NewsletterConfigView>("GET", "/v1/newsletter/config", undefined, signal);
  switch (newsletterGate(config)) {
    case "open":
      return show(
        section(
          "newsletters-title",
          "Newsletters",
          h("p", {}, "Newsletters are connected to Resend."),
          config.configuredAt ? h("p", {}, `Connected ${formatDate(config.configuredAt)}.`) : null,
          h(
            "p",
            {},
            "Publish a post from ",
            h("a", { href: "#/world" }, "Blog"),
            " to send it to your subscribers.",
          ),
        ),
      );
    case "setup":
      return show(setupForm(config));
    case "unavailable":
      return show(
        section(
          "newsletters-title",
          "Newsletters",
          h("p", {}, "Newsletters are not available on this instance."),
          config.detail ? h("p", {}, config.detail) : null,
        ),
      );
    case "not-configured":
      return show(
        section(
          "newsletters-title",
          "Newsletters",
          h(
            "p",
            {},
            config.status === "needs-attention"
              ? "Newsletters need attention."
              : "Newsletters aren't configured yet.",
          ),
          h(
            "p",
            {},
            config.status === "needs-attention"
              ? "An instance operator needs to reconnect Resend before newsletters can be used."
              : "An instance operator needs to connect Resend before newsletters can be used.",
          ),
        ),
      );
  }
};
