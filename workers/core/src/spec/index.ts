// The conventional JSON API (§8) as one HttpApi. Endpoints that aren't plain JSON over a session or
// bearer credential (OAuth, WebAuthn ceremonies, webhooks, uploads, downloads, renders) stay native
// routes (see ../http.ts `route`).
import { HttpApi } from "effect/http-api";
import { AdminApi } from "./admin.ts";
import { CalendarApi } from "./calendar.ts";
import { IdentityApi } from "./identity.ts";
import { MailApi } from "./mail.ts";
import { NewsletterConfigApi } from "./newsletter-config.ts";
import { OpsApi } from "./ops.ts";
import { SharedApi } from "./shared.ts";

export class CoreApi extends HttpApi.make("core")
  .add(IdentityApi)
  .add(MailApi)
  .add(CalendarApi)
  .add(SharedApi)
  .add(AdminApi)
  .add(NewsletterConfigApi)
  .add(OpsApi) {}
