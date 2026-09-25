// Deploy-time scanner signature source (§10). Dependency-free so infra/policies/check-config.ts can
// validate SCANNER_SIGNATURES/SCANNER_IMAGE before a plan, with the same rule the stack applies
// when infra/resources/scanner.ts is loaded. Both names are read from the process environment at
// deploy time (not Worker bindings), and CI maps them into every deploy job.

export type ScannerSignatureSource =
  | { readonly mode: "mirror" }
  | { readonly mode: "baked"; readonly image: string };

/** Deploy-time names read directly from `process.env` (not `Config.*` declarations). */
export const SCANNER_DEPLOY_ENV = ["SCANNER_SIGNATURES", "SCANNER_IMAGE"] as const;

/** Deploy-time selection; a baked deployment must name an exact, digest-pinned image. */
export const scannerSignatureSource = (
  env: Readonly<Record<string, string | undefined>>,
): ScannerSignatureSource => {
  // Empty (an unset CI variable) means the default.
  const mode = env.SCANNER_SIGNATURES?.trim() || "mirror";
  if (mode === "mirror") return { mode };
  if (mode !== "baked")
    throw new Error(`SCANNER_SIGNATURES must be "mirror" or "baked", got ${mode}`);
  const image = env.SCANNER_IMAGE ?? "";
  if (!/@sha256:[0-9a-f]{64}$/.test(image))
    throw new Error(
      "SCANNER_SIGNATURES=baked requires SCANNER_IMAGE pinned by digest (…@sha256:…)",
    );
  return { mode, image };
};
