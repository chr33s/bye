// Push device registration (E23) and external send-as credentials (E19). The operator recovery
// routes (§6, §12) take a separate OPS_TOKEN bearer and stay native routes (../routes/ops.ts).
import {
  ExternalIdentityCredentialRequest,
  PushDeviceList,
  PushDeviceRegistered,
  PushSubscriptionRequest,
} from "@bye/contracts";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi";
import { Ok, RequestServices, SchemaErrors } from "../httpapi.ts";

const externalIdentity = { mailboxId: Schema.String, address: Schema.String };

export class OpsApi extends HttpApiGroup.make("ops")
  .add(
    // ---- push subscriptions (E23, C02/C10) ----
    HttpApiEndpoint.get("listPushSubscriptions", "/v1/push/subscriptions", {
      success: PushDeviceList,
    }),
    /**
     * A registration outlives the credential that made it, so only the account holder's own
     * session (browser or signed-in app) registers — never agent/CLI tokens or support access.
     */
    HttpApiEndpoint.post("registerPushSubscription", "/v1/push/subscriptions", {
      payload: PushSubscriptionRequest,
      success: PushDeviceRegistered.pipe(HttpApiSchema.status(201)),
    }),
    HttpApiEndpoint.delete("removePushSubscription", "/v1/push/subscriptions/:id", {
      params: { id: Schema.String },
      success: Ok,
    }),

    // ---- external send-as credentials (§5.3 ExternalIdentityTransport, E19) ----
    HttpApiEndpoint.put(
      "storeExternalIdentity",
      "/v1/mailboxes/:mailboxId/external-identities/:address",
      { params: externalIdentity, payload: ExternalIdentityCredentialRequest, success: Ok },
    ),
    HttpApiEndpoint.delete(
      "revokeExternalIdentity",
      "/v1/mailboxes/:mailboxId/external-identities/:address",
      { params: externalIdentity, success: Ok },
    ),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
