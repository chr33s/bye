// Where a hosted release's images live in an installation's account (infra/onboarding/spec.md §44,
// §45). Cloudflare Containers run images only from the account's own registry, so each pinned
// image is copied to `registry.cloudflare.com/<account>/<repository>` with its digest unchanged.
import { SHA256_DIGEST } from "../resources/container-images.ts";
import type { ReleaseImages } from "./store.ts";

export const ACCOUNT_REGISTRY = "registry.cloudflare.com";

/** Repository name per release image in the installation's account. */
export const INSTALL_IMAGES: Readonly<Record<keyof ReleaseImages, string>> = {
  deployer: "bye-deployer",
  scanner: "bye-scanner",
  mime: "bye-mime",
  sigmirror: "bye-sigmirror",
};

const PINNED = new RegExp(`^([a-z0-9.-]+(?::\\d+)?)/([a-z0-9._/-]+)@(${SHA256_DIGEST})$`);

export interface ImageRef {
  readonly registry: string;
  readonly repository: string;
  readonly digest: string;
}

/** Parses `registry/repository@sha256:…`; tags and unpinned references are refused. */
export const parseImageRef = (ref: string): ImageRef => {
  const m = PINNED.exec(ref);

  if (!m) throw new Error(`image ${ref} is not a registry reference pinned by digest`);

  return { registry: m[1]!, repository: m[2]!, digest: m[3]! };
};

/** The copy of a pinned source image in an account's registry (same digest). */
export const accountImageRef = (accountId: string, repository: string, source: string): string =>
  `${ACCOUNT_REGISTRY}/${accountId}/${repository}@${parseImageRef(source).digest}`;
