import { build } from "rolldown";

// Bundle the server (and @bye/mail-codec) into dist/server.mjs so the image needs no workspace.
const root = new URL(".", import.meta.url).pathname;

await build({
  input: `${root}src/server.ts`,
  platform: "node",
  output: { file: `${root}dist/server.mjs`, format: "esm" },
  logLevel: "warn",
});

console.log("built containers/mime/dist/server.mjs");
