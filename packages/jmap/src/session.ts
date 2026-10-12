import type { Schema } from "effect";
import {
  BYE,
  CORE,
  CORE_LIMITS,
  MAIL,
  MAIL_ACCOUNT_CAPABILITY,
  PROFILE,
  SUBMISSION,
  SUPPORTED_CAPABILITIES,
  VACATION_RESPONSE,
} from "./capabilities.ts";
import { EMAIL_SORT_PROPERTIES } from "./mail.ts";

/** FUTURERELEASE horizon (spec.md §16 B2), in seconds. */
export const MAX_DELAYED_SEND_SECONDS = 30 * 24 * 3600;

const CORE_SORT_OPTIONS = EMAIL_SORT_PROPERTIES;

import { queryDigest } from "./state.ts";

// Session resource (RFC 8620 §2). It lists only the accounts the principal can discover.

export interface SessionAccount {
  readonly accountId: string;
  readonly name: string;
  readonly isPersonal: boolean;
  readonly isReadOnly: boolean;
  /** `projection`: not yet migrated, read-only and partial; `core`: served by the JMAP core. */
  readonly profile?: "projection" | "core";
}

export interface SessionInput {
  readonly username: string;
  readonly apiUrl: string;
  /** RFC 6570 Level 1 template with {accountId}, {blobId}, {type} and {name}. */
  readonly downloadUrl: string;
  /** RFC 6570 Level 1 template with {accountId}. */
  readonly uploadUrl: string;
  /** RFC 6570 Level 1 template with {types}, {closeafter} and {ping}. */
  readonly eventSourceUrl: string;
  readonly accounts: ReadonlyArray<SessionAccount>;
  readonly primaryAccountId: string | null;
}

export interface Session {
  readonly capabilities: Schema.JsonObject;
  readonly accounts: Schema.JsonObject;
  readonly primaryAccounts: { readonly [capability: string]: string };
  readonly username: string;
  readonly apiUrl: string;
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly eventSourceUrl: string;
  readonly state: string;
}

export const buildSession = (input: SessionInput): Session => {
  const anyCore = input.accounts.some((a) => a.profile === "core");

  const capabilities: Schema.JsonObject = {
    [CORE]: { ...CORE_LIMITS, collationAlgorithms: [...CORE_LIMITS.collationAlgorithms] },
    [MAIL]: {},
    ...(anyCore ? { [SUBMISSION]: {}, [VACATION_RESPONSE]: {} } : undefined),
    [BYE]: { version: 1, partial: !anyCore || input.accounts.some((a) => a.profile !== "core") },
  };

  const accountCapabilities = (a: SessionAccount): Schema.JsonObject =>
    a.profile === "core"
      ? {
          [MAIL]: {
            ...MAIL_ACCOUNT_CAPABILITY,
            emailQuerySortOptions: [...CORE_SORT_OPTIONS],
            mayCreateTopLevelMailbox: true,
            maxMailboxDepth: null,
          },
          [SUBMISSION]: {
            maxDelayedSend: MAX_DELAYED_SEND_SECONDS,
            submissionExtensions: { FUTURERELEASE: [] },
          },
          [VACATION_RESPONSE]: {},
          // Conformance is a release gate (D1/D2), not something this profile asserts.
          [BYE]: { profile: "core", conformance: "unverified" },
        }
      : {
          [MAIL]: {
            ...MAIL_ACCOUNT_CAPABILITY,
            emailQuerySortOptions: [...MAIL_ACCOUNT_CAPABILITY.emailQuerySortOptions],
          },
          [BYE]: { profile: PROFILE, partial: true },
        };

  const accounts: Schema.JsonObject = Object.fromEntries(
    input.accounts.map((a) => [
      a.accountId,
      {
        name: a.name,
        isPersonal: a.isPersonal,
        isReadOnly: a.isReadOnly,
        accountCapabilities: accountCapabilities(a),
      },
    ]),
  );

  const primaryAccounts: { [capability: string]: string } = {};
  const primary = input.accounts.find((a) => a.accountId === input.primaryAccountId);

  if (primary)
    for (const capability of SUPPORTED_CAPABILITIES)
      if (capability !== CORE && Object.hasOwn(accountCapabilities(primary), capability))
        primaryAccounts[capability] = primary.accountId;

  // The session state changes whenever anything in the resource changes (RFC 8620 §2).
  const state = queryDigest({
    username: input.username,
    accounts,
    primaryAccounts,
    profile: PROFILE,
    urls: [input.apiUrl, input.downloadUrl, input.uploadUrl, input.eventSourceUrl],
  });

  return {
    capabilities,
    accounts,
    primaryAccounts,
    username: input.username,
    apiUrl: input.apiUrl,
    downloadUrl: input.downloadUrl,
    uploadUrl: input.uploadUrl,
    eventSourceUrl: input.eventSourceUrl,
    state,
  };
};

/** Expand an RFC 6570 Level 1 template (simple string expansion, percent-encoded). */
export const expandTemplate = (
  template: string,
  values: { readonly [name: string]: string },
): string =>
  template.replace(/\{([A-Za-z]+)\}/g, (_, name: string) => encodeURIComponent(values[name] ?? ""));
