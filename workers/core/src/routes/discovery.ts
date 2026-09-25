// Public, unauthenticated discovery documents for native clients (spec §10 "Instance
// selection, self-hosting, and distribution"). One released app or CLI works against any compatible instance: it validates this
// instance's compatibility document, then the RFC 8414 authorization-server metadata derived from
// the advertised issuer, before it saves the instance or starts a sign-in.
import { DEVICE_CLIENTS, DEVICE_GRANT_CLIENTS } from "@bye/platform-cloudflare";
import type { CoreEnv } from "../env.ts";
import { json, route, type Route } from "../http.ts";

/** Compatibility-document schema identifier; bumped only for incompatible document changes. */
export const INSTANCE_SCHEMA = "bye.instance/1";
export const INSTANCE_DOCUMENT_PATH = "/.well-known/bye-instance";
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
/** The /v1 API revisions this deployment serves. */
export const API_COMPATIBILITY = { min: 1, max: 1 } as const;

/** Capability names clients gate features on; unknown names are ignored by clients. */
export const INSTANCE_CAPABILITIES = [
  "mail",
  "calendar",
  "device-session",
  "device-authorization",
  "authorization-response-iss",
  "account-deletion",
] as const;

/** The issuer is the app origin without a trailing slash (RFC 8414 §2: no query or fragment). */
export const issuerOf = (env: Pick<CoreEnv, "APP_ORIGIN">): string =>
  new URL(env.APP_ORIGIN).origin;

export const instanceDocument = (env: Pick<CoreEnv, "APP_ORIGIN">) => {
  const issuer = issuerOf(env);
  return {
    schema: INSTANCE_SCHEMA,
    baseUrl: issuer,
    issuer,
    api: API_COMPATIBILITY,
    authorizationServerMetadata: `${issuer}${AS_METADATA_PATH}`,
    clients: DEVICE_CLIENTS.map((c) => ({
      clientId: c.clientId,
      redirectUris: c.redirects,
      loopback: c.loopbackPath !== undefined,
      deviceAuthorization: DEVICE_GRANT_CLIENTS.includes(c.clientId),
    })),
    capabilities: INSTANCE_CAPABILITIES,
    routes: {
      accountDeletion: `${issuer}/v1/account/close`,
      accountDeletionWeb: `${issuer}/#/settings`,
      support: `${issuer}/#/settings`,
    },
  };
};

/** RFC 8414 §2 metadata. `authorization_response_iss_parameter_supported` is RFC 9207 §3. */
export const authorizationServerMetadata = (env: Pick<CoreEnv, "APP_ORIGIN">) => {
  const issuer = issuerOf(env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      "urn:ietf:params:oauth:grant-type:device_code",
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  };
};

// Public and credential-free: clients probe without cookies, so the documents may be cached briefly.
const PUBLIC = { "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };

export const discoveryRoutes: ReadonlyArray<Route<CoreEnv>> = [
  route("GET", INSTANCE_DOCUMENT_PATH, async (_r, _p, env) =>
    json(instanceDocument(env), 200, PUBLIC),
  ),
  route("GET", AS_METADATA_PATH, async (_r, _p, env) =>
    json(authorizationServerMetadata(env), 200, PUBLIC),
  ),
];
