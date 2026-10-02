import { Schema } from "effect";
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { requireStage } from "../resources/stage.ts";
import { cfRunner } from "./command.ts";
import { workerMetadata } from "./metadata.ts";
import { discover } from "./discover.ts";
import { adopt } from "./adoption.ts";
import { adoptionResourceMap, loadResourceMap, newResourceMap } from "./resource-map.ts";
import { desiredResources } from "./desired.ts";
import { planResources } from "./plan.ts";
import { canonical, exportPlan } from "./plan-normalize.ts";
import { approvalDigest, approvalSubject } from "./evidence.ts";
import { releaseSubject } from "./subject.ts";
import { applyRelease } from "./apply.ts";
import { destructionSubject, destroy } from "./destroy.ts";
import { foundationPlan, applyFoundation, type OwnedRule } from "./foundation.ts";
import { httpWriterLocks, writerKey } from "./locks.ts";
import { operationRunner } from "./operations.ts";
import { digest } from "./plan-normalize.ts";
import { writeArtifact } from "./artifacts.ts";
import { assertNoSecrets, decode, Adoption } from "./schemas.ts";

export const main = async (argv = process.argv.slice(2)): Promise<void> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stage: { type: "string" },
      out: { type: "string" },
      "resource-map": { type: "string" },
      adoption: { type: "string" },
      "approved-digest": { type: "string" },
      decommissions: { type: "string" },
      rules: { type: "string" },
      "initial-stage": { type: "boolean", default: false },
    },
  });

  const operation = positionals[0];

  if (
    !operation ||
    !["discover", "adopt", "plan", "drift", "apply", "destroy", "foundation", "new-map"].includes(
      operation,
    ) ||
    positionals.length !== 1
  )
    throw new Error(
      "usage: cli.ts <discover|adopt|plan|drift|apply|destroy|foundation|new-map> --stage <stage> --resource-map <path> --out <path> [--adoption <path>]",
    );
  const stage = requireStage(values.stage ?? process.env.STAGE ?? "");

  const environment = {
    ...process.env,
    STAGE: stage.name,
    BYE_CF_INITIAL_STAGE: values["initial-stage"] ? "1" : (process.env.BYE_CF_INITIAL_STAGE ?? ""),
  };

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const path = values["resource-map"] ?? process.env.BYE_CF_RESOURCE_MAP;
  const output = values.out ?? process.env.BYE_CF_OUTPUT;
  const approvedDigest = values["approved-digest"] ?? process.env.BYE_CF_APPROVED_DIGEST;
  const adoptionPath = values.adoption ?? process.env.BYE_CF_ADOPTION;

  const locks = () =>
    httpWriterLocks({
      origin: process.env.BYE_CF_LOCK_URL ?? "",
      credential: process.env.BYE_CF_LOCK_CREDENTIAL ?? "",
    });

  if (operation === "new-map") {
    if (!accountId || !output) throw new Error("new-map requires explicit account and --out");
    writeArtifact(
      resolve(output),
      newResourceMap(
        stage.name,
        accountId,
        process.env.BYE_WORKERS_DEV_NAME || undefined,
        environment.BYE_CF_INITIAL_STAGE === "1",
      ),
    );

    return;
  }

  if (operation === "foundation") {
    if (!values.rules || !accountId || !output)
      throw new Error("foundation requires explicit account, --rules and --out");

    const Rule = Schema.Struct({
      zoneId: Schema.NonEmptyString,
      zoneName: Schema.NonEmptyString,
      rulesetId: Schema.NonEmptyString,
      ruleId: Schema.NonEmptyString,
      reference: Schema.NonEmptyString,
      phase: Schema.Literals(["http_request_firewall_custom", "http_ratelimit"]),
      settings: Schema.Json,
    });

    const desired: ReadonlyArray<OwnedRule> = decode(
      Schema.Array(Rule),
      JSON.parse(readFileSync(values.rules, "utf8")),
    );

    const operations = { read: cfRunner(), write: operationRunner({ env: process.env }) };

    if (!approvedDigest) {
      const changes = await foundationPlan(operations, desired);
      writeArtifact(resolve(output), { changes, digest: digest(changes) });
    } else {
      const lease = await locks().acquire(
        writerKey(accountId, stage.name),
        process.env.GITHUB_RUN_ID ?? "operator",
      );

      let writing = false;
      let complete = false;

      try {
        await applyFoundation({
          engine: process.env.BYE_DEPLOY_ENGINE ?? "",
          desired,
          approvedDigest,
          operations,
          beforeWrite: async () => {
            await lease.assertHeld();
            writing = true;
          },
        });
        writeArtifact(resolve(output), { status: "complete", approvedDigest });
        complete = true;
      } catch (cause) {
        writeArtifact(resolve(output), {
          status: writing ? "unknown" : "rejected",
          approvedDigest,
          leaseId: lease.leaseId ?? "",
        });
        throw cause;
      } finally {
        if (!writing || complete) await lease.release();
      }
    }

    return;
  }

  if (!accountId || !path || !output)
    throw new Error("explicit account ID, resource map and --out are required");
  const map = loadResourceMap(resolve(path), stage.name, accountId);

  if (operation === "apply") {
    if (!approvedDigest) throw new Error("cf apply requires a reviewed --approved-digest");
    await applyRelease({
      map,
      adoptionPath,
      approvedDigest,
      evidenceDirectory: resolve(output),
      env: environment,
    });

    return;
  }

  const snapshot = await discover(
    cfRunner(),
    map,
    workerMetadata({ accountId, apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" }),
  );

  const write = <T>(value: T, output: string) => {
    assertNoSecrets(value);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${canonical(value)}\n`, { mode: 0o600, flag: "wx" });
  };

  if (operation === "destroy") {
    if (!values.decommissions) throw new Error("destroy requires explicit --decommissions");

    const Record = Schema.Struct({
      stage: Schema.NonEmptyString,
      logicalId: Schema.NonEmptyString,
      action: Schema.Literals(["delete", "replace"]),
      approvedBy: Schema.NonEmptyString,
      ticket: Schema.NonEmptyString,
    });

    const decommissions = decode(
      Schema.Array(Record),
      JSON.parse(readFileSync(values.decommissions, "utf8")),
    );

    if (!approvedDigest) {
      if (stage.persistent || snapshot.blockers.length)
        throw new Error("persistent/incomplete destruction plan rejected");
      const subject = destructionSubject(snapshot, decommissions);
      write({ subject, digest: digest(subject) }, resolve(output));
    } else {
      await destroy({
        engine: process.env.BYE_DEPLOY_ENGINE ?? "",
        stage: stage.name,
        accountId,
        owner: process.env.GITHUB_RUN_ID ?? "operator",
        installation: process.env.BYE_WORKERS_DEV_NAME || undefined,
        approvedDigest,
        decommissions,
        discover: () =>
          discover(
            cfRunner(),
            map,
            workerMetadata({ accountId, apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "" }),
          ),
        locks: locks(),
        runner: operationRunner({ env: process.env }),
        record: async (result) => write(result, resolve(output)),
      });
    }

    return;
  }

  if (operation === "discover") {
    write(snapshot, resolve(output));

    return;
  }

  if (operation === "adopt") {
    const adoption = adopt(snapshot, stage.name, accountId);
    write(adoption, resolve(output));
    write(adoptionResourceMap(adoption), `${resolve(output)}.resources.json`);

    return;
  }

  // Preserve incomplete discovery for operator review even when no valid plan can be emitted.
  write(snapshot, `${resolve(output)}.discovery.json`);

  const adoption = adoptionPath
    ? decode(Adoption, JSON.parse(readFileSync(resolve(adoptionPath), "utf8")))
    : undefined;

  const plan = planResources({
    stage: stage.name,
    accountId,
    desired: desiredResources(map, environment),
    discovery: snapshot,
    adoption,
  });

  write(plan, resolve(output));

  const domains = Object.fromEntries(
    desiredResources(map, environment)
      .filter((r) => r.type === "Cloudflare.Worker")
      .map((r) => [r.logicalId, decodeDomains(r.settings.domains)]),
  );

  const subject = releaseSubject({
    root: resolve(import.meta.dirname, "../.."),
    map,
    discovery: snapshot,
    plan,
    env: environment,
  });

  const subjectDigest = approvalDigest(subject);
  write(
    { subject: approvalSubject(subject), digest: subjectDigest },
    `${resolve(output)}.approval.json`,
  );
  write(
    { ...exportPlan(plan, domains), deploymentEngine: "cf", cfApprovalDigest: subjectDigest },
    `${resolve(output)}.export.json`,
  );

  if (operation === "drift" && plan.entries.some((entry) => entry.action !== "noop"))
    process.exitCode = 1;
};

const decodeDomains = (
  value: Schema.Schema.Type<typeof Schema.Json> | undefined,
): ReadonlyArray<string> => decode(Schema.Array(Schema.String), value);

if (process.argv[1] === import.meta.filename)
  main().catch((cause: unknown) => {
    // Boundary errors contain operation/field names, never raw API payloads.
    console.error(cause instanceof Error ? cause.message : "Cloudflare planning failed");
    process.exitCode = 1;
  });
