// Instance newsletter provider configuration (infra/onboarding/spec.md §23).
import { NewsletterConfigRequest, NewsletterConfigView } from "@bye/contracts";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { RequestServices, SchemaErrors } from "../httpapi.ts";

export class NewsletterConfigApi extends HttpApiGroup.make("newsletterConfig")
  .add(
    HttpApiEndpoint.get("status", "/v1/newsletter/config", { success: NewsletterConfigView }),
    HttpApiEndpoint.post("configure", "/v1/newsletter/config", {
      payload: NewsletterConfigRequest,
      success: NewsletterConfigView,
    }),
  )
  .middleware(SchemaErrors)
  .middleware(RequestServices) {}
