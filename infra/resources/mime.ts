// Exceptional MIME processing (§3.1 Containers, §5.1 step 5): a bounded, isolated container that
// parses oversized or over-limit messages the in-isolate parser must not hold in memory. Stateless;
// customer bytes are never written to container disk.
import * as Cloudflare from "alchemy/Cloudflare";
import { prebuiltImage } from "./container-images.ts";
import type { CoreClasses } from "./runtime-types.ts";

export const MIME_MAX_INSTANCES = 5;

const image = prebuiltImage(process.env, "MIME_IMAGE");

export const MimeParser = Cloudflare.Container<CoreClasses["MimeContainer"]>("MimeParser", {
  ...(image ? { image } : { context: "./containers/mime" }),
  className: "MimeContainer",
  instanceType: "standard-1",
  maxInstances: MIME_MAX_INSTANCES,
});
