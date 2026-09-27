// Application stack per stage (§15.2). The foundation stack (state backend bootstrap, zones,
// account-level WAF) is administered separately; this stack references it, never owns it.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Config, Effect } from "effect";
import {
  CONSUMER_POLICY,
  DeadLetters,
  DLQ_CONSUMER_POLICY,
  QUEUE_NAMES,
  queueIds,
  Queues,
} from "./resources/queues.ts";
import { classifyStage, mailRoutingZone } from "./resources/stage.ts";
import { makeSigMirror } from "./resources/sigmirror.ts";
import {
  ConfigCache,
  Directory,
  Exports,
  Originals,
  Parts,
  Published,
} from "./resources/storage.ts";
import { makeCore, makePublic, makeRenderOrigin } from "./resources/workers.ts";
import { selectState } from "./state/client.ts";

export * from "./resources/storage.ts";
export * from "./resources/durable.ts";
export * from "./resources/queues.ts";
export type { CoreEnv, PublicEnv } from "./resources/workers.ts";

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));

export default Alchemy.Stack(
  "MailboxPlatform",
  {
    providers: Cloudflare.providers(),
    // STATE_BACKEND=http (required for the strict Cloudflare-only profile, §15.7) selects the
    // foundation-owned, telemetry-free state Worker (infra/state). The default keeps
    // `Cloudflare.state()`, whose state-store Worker is alchemy-built; see EXTERNAL_OWNERS.md.
    state: selectState(),
  },
  Effect.gen(function* () {
    const stageName = yield* Alchemy.Stage;
    const classified = classifyStage(stageName);
    if (classified._tag === "Invalid") return yield* Effect.die(new Error(classified.reason));
    const stage = classified.stage;

    const appDomain = (yield* optional("APP_DOMAIN")) || undefined;
    const publicDomain = (yield* optional("PUBLIC_DOMAIN")) || undefined;
    const mailZone = (yield* optional("MAIL_ZONE")) || undefined;
    // Onboarding installations (spec.md §15.11): Worker names fixed at install time so the
    // workers.dev origins are known up front. Keep it set for the installation's lifetime:
    // changing or removing it renames the Workers, which replaces them and their DO namespaces.
    const workersDevName = (yield* optional("BYE_WORKERS_DEV_NAME")) || undefined;
    const install = workersDevName === undefined ? undefined : { name: workersDevName };

    // Persistent stages retain physical data resources on removal or replacement; deletion is
    // a separately approved decommission (§15.6). Plan policy enforces the same rule upstream.
    const persistent = Alchemy.RemovalPolicy.retain(stage.persistent);

    // Register every data resource here, explicitly decorated, before any Worker binds it: the
    // first registration fixes a resource's policy, so retention never depends on which Worker
    // happens to declare the binding first. Durable Object namespaces and Workflows are part of
    // their host Worker (MailCore), which is retained below; containers hold no data.
    yield* Directory.pipe(persistent);
    yield* Originals.pipe(persistent);
    yield* Parts.pipe(persistent);
    yield* Exports.pipe(persistent);
    yield* Published.pipe(persistent);
    yield* ConfigCache.pipe(persistent);
    for (const name of QUEUE_NAMES) {
      yield* Queues[name].pipe(persistent);
      yield* DeadLetters[name].pipe(persistent);
    }

    // Private ClamAV mirror: the only signature egress point; scanners read it via an intercepted
    // service binding (SIGMIRROR), so scanner containers run with enableInternet: false.
    const sigmirror = yield* makeSigMirror(stage).pipe(persistent);
    // Canary (§15.9): BYE_CANARY_PERCENT is computed by infra/policies/canary.ts in CI (100 when
    // class migrations changed). Unset/100 = full cutover.
    const canary = Number((yield* optional("BYE_CANARY_PERCENT")) || "100");
    const core = yield* makeCore(
      stage,
      appDomain,
      sigmirror,
      stage.persistent && canary < 100 ? canary : undefined,
      install,
    ).pipe(persistent);
    const site = yield* makePublic(stage, publicDomain, core, install).pipe(persistent);
    const render =
      install === undefined ? undefined : yield* makeRenderOrigin(stage, core, install);

    // Explicit consumer wiring for the native queue handler; one mechanism per subscription (§15.4).
    for (const name of QUEUE_NAMES) {
      const queue = yield* Queues[name];
      const dlq = yield* DeadLetters[name];
      const policy = CONSUMER_POLICY[name];
      const ids = queueIds(name);
      yield* Cloudflare.Queues.Consumer(ids.consumer, {
        queueId: queue.queueId,
        scriptName: core.workerName,
        deadLetterQueue: dlq.queueName,
        settings: {
          batchSize: policy.batchSize,
          maxRetries: policy.maxRetries,
          maxWaitTimeMs: policy.maxWaitTimeMs,
          maxConcurrency: policy.maxConcurrency,
          retryDelay: policy.retryDelay,
        },
      });
      // DLQ drain (§6): dead letters are persisted to D1 for operator inspection and validated
      // replay; the queue itself is never treated as the permanent record.
      yield* Cloudflare.Queues.Consumer(ids.deadLetterConsumer, {
        queueId: dlq.queueId,
        scriptName: core.workerName,
        settings: { ...DLQ_CONSUMER_POLICY },
      });
    }

    // Service-owned inbound zone only. Previews never attach MX routing (§15.8); customer zones
    // are provisioned by the application's domain workflow, not by this stack.
    // MX cutover gate (§15.4 "preserve current MX service until a tested cutover"): enabling Email
    // Routing takes over the zone's MX, so it only happens once BYE_MX_CUTOVER=approved is set for
    // the stage after the cutover checklist (RUNBOOK "MX cutover") has been signed off.
    const routedZone = mailRoutingZone(stage, mailZone, yield* optional("BYE_MX_CUTOVER"));
    if (routedZone !== undefined) {
      yield* Cloudflare.Email.Routing("MailRouting", { zone: routedZone, enabled: true }).pipe(
        persistent,
      );
      yield* Cloudflare.Email.CatchAll("MailCatchAll", {
        zone: routedZone,
        enabled: true,
        actions: [{ type: "worker", value: [core.workerName] }],
      }).pipe(persistent);
    }

    let turnstileSitekey: Alchemy.Output<string> | undefined;
    // Onboarding installations (BYE_WORKERS_DEV_NAME) create their first account with the
    // single-use BOOTSTRAP_TOKEN instead, so their custom hostname adds no Turnstile widget: the
    // only zone-level change onboarding makes is MailCore's custom domain.
    if (appDomain !== undefined && install === undefined) {
      // Two-phase first deploy (RUNBOOK "First deploy: Turnstile"): this widget's secret feeds
      // TURNSTILE_SECRET, so the widget is retained with the stage and never silently recreated.
      const widget = yield* Cloudflare.Turnstile.Widget("SignupChallenge", {
        domains: [appDomain],
        mode: "managed",
      }).pipe(persistent);
      turnstileSitekey = widget.sitekey.as<string>();
    }

    return {
      stage: stage.name,
      coreUrl: core.url.as<string>(),
      publicUrl: site.url.as<string>(),
      // Canary probes pin the new version with Cloudflare-Workers-Version-Overrides
      // (infra/probes/run.ts); set only while a gradual rollout (canary < 100) is in flight.
      coreWorkerName: core.workerName.as<string>(),
      coreVersionId: core.versionId.as<string | undefined>(),
      ...(turnstileSitekey === undefined ? {} : { turnstileSitekey }),
      ...(render === undefined ? {} : { renderUrl: render.url.as<string>() }),
    };
  }),
);
