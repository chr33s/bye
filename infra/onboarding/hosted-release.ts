// The pinned release as data (infra/onboarding/spec.md §45): what the hosted service knows about the
// release it installs, without a checkout. Written by release-manifest.ts into release-pin.ts.
import type { ReleaseQualification, ReleaseResolution } from "./release.ts";
import type { ReleaseSource } from "./service.ts";
import type { ReleaseRef } from "./store.ts";

export interface ReleaseManifest {
  readonly format: "bye.onboarding-release.v1";
  /** Tag, commit, lockfile digest and the four image digests. */
  readonly ref: ReleaseRef & { readonly images: NonNullable<ReleaseRef["images"]> };
  /** Migration IDs the release ships (release.ts `releaseMigrations`). */
  readonly migrations: ReadonlyArray<string>;
  /** Stack configuration names the release requires (check-config.ts `requiredConfig`). */
  readonly requiredConfig: ReadonlyArray<string>;
  readonly qualification: ReleaseQualification;
}

/** Where the deployer image keeps the release checkout (deployer/Dockerfile). */
export const DEPLOYER_RELEASE_DIR = "/srv/bye";

export const manifestRelease = (pin: ReleaseManifest | null): ReleaseSource => ({
  resolve: (): ReleaseResolution =>
    pin === null
      ? { ok: false, reason: "no Bye release is pinned for onboarding yet" }
      : {
          ok: true,
          release: { ref: pin.ref, dir: DEPLOYER_RELEASE_DIR, qualification: pin.qualification },
        },
  migrations: async () => pin?.migrations ?? [],
  requiredConfig: () => pin?.requiredConfig ?? [],
});
