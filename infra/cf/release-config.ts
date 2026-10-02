import {
  domainProblems,
  forbiddenConfig,
  unsandboxedMail,
  missingPreviewAttestation,
  webhookSecretProblems,
  scannerProblems,
} from "../policies/check-config.ts";
import { requireStage } from "../resources/stage.ts";

/** Shared application safety gates remain in force when the deployment engine changes. */
export const assertReleaseConfig = (
  stageName: string,
  env: Readonly<Record<string, string | undefined>>,
): void => {
  const stage = requireStage(stageName);

  if (stage.persistent && env.CI !== "true" && env.BYE_DEPLOY_WRITER !== "onboarding")
    throw new Error("persistent releases run only from CI or the onboarding service");

  const problems = [
    ...domainProblems(env),
    ...forbiddenConfig(env).map((name) => `${name} is forbidden on ${stageName}`),
    ...unsandboxedMail(env).map((name) => `${name} requires MAIL_SANDBOX_DOMAINS`),
    ...webhookSecretProblems(env),
    ...scannerProblems(env),
  ];

  if (missingPreviewAttestation(env))
    problems.push("PROVIDER_SENT_PREVIEWS must be disabled before persistent mail deployment");

  if (problems.length) throw new Error(`cf release configuration rejected: ${problems.join("; ")}`);
};
