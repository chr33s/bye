import { TransportFailure } from "@bye/application";
import { Effect } from "effect";
import type { TransportAdapter } from "./router.ts";

// Preview mail sandbox (§15.8): previews use sandbox delivery and deny arbitrary external
// recipients. Wraps every adapter so a preview can only ever mail its own disposable domains; any
// other envelope recipient is a permanent rejection before the provider sees the submission.
// Wiring (MailCore dispatch): when MAIL_SANDBOX_DOMAINS is non-empty, wrap each adapter with
// `sandboxTransport(adapter, MAIL_SANDBOX_DOMAINS.split(","))`.

export const parseSandboxDomains = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));

export const sandboxRecipientAllowed = (
  address: string,
  domains: ReadonlyArray<string>,
): boolean => {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return domains.some((d) => domain === d || domain.endsWith(`.${d}`));
};

export const sandboxTransport = (
  inner: TransportAdapter,
  domains: ReadonlyArray<string>,
): TransportAdapter => ({
  capabilities: { ...inner.capabilities, name: `sandbox(${inner.capabilities.name})` },
  submit: (submission) => {
    const denied = submission.envelopeRecipients.filter(
      (r) => !sandboxRecipientAllowed(r, domains),
    );
    if (domains.length === 0 || denied.length > 0) {
      return Effect.fail(
        new TransportFailure({
          kind: "Rejected",
          detail: `sandbox: ${denied.length || submission.envelopeRecipients.length} recipient(s) outside the preview's allowed domains`,
        }),
      );
    }
    return inner.submit(submission);
  },
});
