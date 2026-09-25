// Deployment telemetry controls (§15.7). CLI export is disabled through environment flags.
// These flags do NOT disable the Cloudflare state-store Worker's OTLP exporter; strict
// Cloudflare-only operation additionally requires an audited state-store build (EXTERNAL_OWNERS.md).

export const REQUIRED_DEPLOY_ENV: Readonly<Record<string, string>> = {
  ALCHEMY_TELEMETRY_DISABLED: "1",
  DO_NOT_TRACK: "1",
  NO_TRACK: "1",
};

export const missingTelemetryOptOuts = (
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyArray<string> =>
  Object.entries(REQUIRED_DEPLOY_ENV)
    .filter(([key, value]) => env[key] !== value)
    .map(([key]) => key);

/** Every deploy-related package script must set the opt-outs inline. */
export const scriptsMissingOptOut = (
  scripts: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Object.entries(scripts)
    .filter(([, command]) => /\balchemy\s+(deploy|plan|destroy|dev|drift|state)\b/.test(command))
    .filter(([, command]) =>
      Object.entries(REQUIRED_DEPLOY_ENV).some(([k, v]) => !command.includes(`${k}=${v}`)),
    )
    .map(([name]) => name);
