import { instanceKey, type ValidatedInstance } from "../src/instance/discovery.ts";

/** A validated instance whose issuer is its own origin and whose endpoints follow the Bye server. */
export const testInstance = (baseUrl: string, issuer = baseUrl): ValidatedInstance => ({
  key: instanceKey(baseUrl, issuer),
  baseUrl,
  issuer,
  endpoints: {
    authorization: `${issuer}/oauth/authorize`,
    token: `${issuer}/oauth/token`,
    revocation: `${issuer}/oauth/revoke`,
    deviceAuthorization: `${issuer}/oauth/device_authorization`,
  },
  api: { min: 1, max: 1 },
  capabilities: ["device-session", "authorization-response-iss"],
  clients: [
    { clientId: "bye-desktop", redirectUris: ["bye://oauth/callback"], loopback: true },
    { clientId: "bye-mobile", redirectUris: ["bye://oauth/callback"], loopback: false },
  ],
  routes: { accountDeletion: null, accountDeletionWeb: null, support: null },
  validatedAt: 0,
});
