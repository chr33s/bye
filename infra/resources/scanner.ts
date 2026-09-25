// Media and scans (§15.4): isolated ClamAV container backing the `ScannerContainer` Durable Object
// class on MailCore. Stateless, no persistent disk data (§3.1). `standard-1` because clamd holds
// the signature set (~1.2 GiB) in memory.
//
// Signature source (deploy-time SCANNER_SIGNATURES):
//   mirror (default) — built from containers/scanner; freshclam refreshes from the private
//                      SigMirror (infra/resources/sigmirror.ts); no runtime egress.
//   baked            — the daily CI image (.github/workflows/scanner-image.yml) with signatures
//                      baked in, referenced by SCANNER_IMAGE; no runtime egress, no mirror needed.
import * as Cloudflare from "alchemy/Cloudflare";
import type { CoreClasses } from "./runtime-types.ts";
import { scannerSignatureSource } from "./scanner-source.ts";

export const SCANNER_MAX_INSTANCES = 10;

export { type ScannerSignatureSource, scannerSignatureSource } from "./scanner-source.ts";

const source = scannerSignatureSource(process.env);

export const Scanner = Cloudflare.Container<CoreClasses["ScannerContainer"]>("Scanner", {
  ...(source.mode === "baked" ? { image: source.image } : { context: "./containers/scanner" }),
  className: "ScannerContainer",
  instanceType: "standard-1",
  maxInstances: SCANNER_MAX_INSTANCES,
});
