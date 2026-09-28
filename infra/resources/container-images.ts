// Prebuilt container images (infra/onboarding/spec.md §45). With an image set, Alchemy deploys it
// as-is instead of building the container context, which is how onboarding deploys from a host
// without Docker: the images are copied into the target account's registry first. Dependency-free
// so infra/policies/check-config.ts validates them with the stack's own rule before a plan.

/** Deploy-time names read directly from `process.env` (not `Config.*` declarations). */
export const PREBUILT_IMAGE_ENV = ["MIME_IMAGE", "SIGMIRROR_IMAGE"] as const;

export type PrebuiltImageName = (typeof PREBUILT_IMAGE_ENV)[number];

/** A sha256 content digest, the only pin images accept (scanner, prebuilt and release images). */
export const SHA256_DIGEST = "sha256:[0-9a-f]{64}";

/** A reference that ends in a digest pin. */
export const DIGEST_PINNED = new RegExp(`@${SHA256_DIGEST}$`);

/** The pinned image, or undefined to build from the context. Empty counts as unset. */
export const prebuiltImage = (
  env: Readonly<Record<string, string | undefined>>,
  name: PrebuiltImageName,
): string | undefined => {
  const image = env[name]?.trim() ?? "";

  if (image === "") return undefined;

  if (!DIGEST_PINNED.test(image)) throw new Error(`${name} must be pinned by digest (…@sha256:…)`);

  return image;
};
