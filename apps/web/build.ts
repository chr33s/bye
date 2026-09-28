import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { build } from "rolldown";
import { domainDefaults } from "../../infra/resources/domain.ts";

// Builds the PWA into apps/web/dist, served by MailCore static assets. No secrets are compiled into
// the bundle (§15.4 API and clients); the only build-time values are public ones:
//
//   TURNSTILE_SITEKEY   Turnstile widget sitekey (public by design). Empty → signup can't pass
//                       Turnstile; warned about, never fatal.
//   MAIL_RENDER_ORIGIN  message render origin; the only non-Turnstile origin frames may load.
//   APP_ORIGIN          the app origin; its wss: form is listed for the live socket.
//   DOMAIN              base domain; on prod an unset APP_ORIGIN/MAIL_RENDER_ORIGIN defaults to
//                       https://app.<DOMAIN> / https://mail.<DOMAIN>, on staging to
//                       https://app.staging.<DOMAIN> / https://mail.staging.<DOMAIN>.
//   BYE_WEB_STRICT=1    (or STAGE=prod|staging) fail when an origin is missing or not https.
//
// Output: content-hashed app.<hash>.js / styles.<hash>.css (immutable), a fixed-name sw.js whose
// cache name and shell list carry the build hash, a `_headers` file with the security headers for
// asset responses, and source maps written to apps/web/sourcemaps/ (for upload to an error
// service), never to dist.

const root = new URL(".", import.meta.url).pathname;

const dist = `${root}dist`;

const maps = `${root}sourcemaps`;

const persistent = ["prod", "staging"].includes(process.env["STAGE"] ?? "");

// Unset origins default from DOMAIN and STAGE exactly as the stack does (infra/resources/domain.ts).
const env = { ...process.env, ...domainDefaults(process.env) };

const strict = env["BYE_WEB_STRICT"] === "1" || persistent;

const need = (name: string, required = strict): string => {
  const value = (env[name] ?? "").trim();

  if (!value) {
    const message = `build:web: ${name} is not set`;

    if (required) throw new Error(message);
    console.warn(`warning: ${message}${strict ? "" : " (development build)"}`);
  }

  return value;
};

/** An https origin (or http for local dev) with nothing after the host. */
const origin = (name: string): string | null => {
  const value = need(name);

  if (!value) return null;
  const url = new URL(value);

  if (url.protocol !== "https:" && !(url.protocol === "http:" && !strict))
    throw new Error(`build:web: ${name} must be an https origin`);

  return url.origin;
};

// Warn only, even in strict builds: the widget is created by the first deploy, so the sitekey can be
// missing until a second build (see the Turnstile bootstrap note in todo.md). Signup needs it.
const sitekey = need("TURNSTILE_SITEKEY", false);

if (sitekey && !/^[\w-]{1,64}$/.test(sitekey))
  throw new Error("build:web: TURNSTILE_SITEKEY is malformed");

const renderOrigin = origin("MAIL_RENDER_ORIGIN");

const appOrigin = origin("APP_ORIGIN");

const TURNSTILE = "https://challenges.cloudflare.com";

/**
 * One policy for the meta tag and the `_headers` response header. `connect-src 'self'` covers the
 * same-host ws:/wss: live socket in CSP3 browsers; the explicit wss: origin keeps older Safari
 * working. Without a render origin (dev), frames are limited to Turnstile and message bodies will not
 * render, which is safer than allowing every https origin.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE}`,
  "style-src 'self'",
  "img-src 'self' data: blob:",
  `frame-src ${[renderOrigin, TURNSTILE].filter(Boolean).join(" ")}`,
  `connect-src 'self'${appOrigin ? ` ${appOrigin.replace(/^http/, "ws")}` : ""}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Would rewrite a plain-http local dev server's own requests to https.
  ...(appOrigin?.startsWith("http:") ? [] : ["upgrade-insecure-requests"]),
];

/** Directives that only work as a header (ignored in a meta tag). */
const headerOnly = ["frame-ancestors 'none'"];

const hash = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex").slice(0, 12);

await rm(dist, { recursive: true, force: true });

await rm(maps, { recursive: true, force: true });

await mkdir(dist, { recursive: true });

await mkdir(maps, { recursive: true });

await cp(`${root}public`, dist, {
  recursive: true,
  filter: (src) => !/\/(index\.html|styles\.css)$/.test(src),
});

// App bundle: hashed file names, hidden source maps moved out of dist.
const app = await build({
  input: `${root}src/main.ts`,
  output: {
    dir: dist,
    format: "esm",
    minify: true,
    sourcemap: "hidden",
    entryFileNames: "app.[hash].js",
    chunkFileNames: "chunk.[hash].js",
  },
  platform: "browser",
});

const appFiles = app.output.filter((o) => o.type === "chunk").map((o) => o.fileName);

const appEntry = app.output.find((o) => o.type === "chunk" && o.isEntry)!.fileName;

const styles = await readFile(`${root}public/styles.css`, "utf8");

const stylesFile = `styles.${hash(styles)}.css`;

await writeFile(`${dist}/${stylesFile}`, styles);

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const template = await readFile(`${root}public/index.html`, "utf8");

const html = template
  .replace(
    /<meta name="turnstile-sitekey" content="[^"]*"/,
    () => `<meta name="turnstile-sitekey" content="${escapeAttr(sitekey)}"`,
  )
  .replace(
    /(http-equiv="Content-Security-Policy"\s+content=")[^"]*"/,
    (_m, head: string) => `${head}${escapeAttr(csp.join("; "))}"`,
  )
  .replace('src="/app.js"', `src="/${appEntry}"`)
  .replace('href="/styles.css"', `href="/${stylesFile}"`);

if (!html.includes(appEntry) || !html.includes(stylesFile) || !html.includes("form-action"))
  throw new Error("build:web: index.html template no longer matches build.ts");

await writeFile(`${dist}/index.html`, html);

// The service worker keeps a fixed URL; its cache name and shell list change with every build.
const shell = [
  "/",
  "/index.html",
  ...appFiles.map((f) => `/${f}`),
  `/${stylesFile}`,
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
];

const contents = await Promise.all(
  [...appFiles, stylesFile, "index.html", "manifest.webmanifest"].map((f) =>
    readFile(`${dist}/${f}`),
  ),
);

const buildHash = hash(Buffer.concat(contents));

await build({
  input: `${root}src/sw.ts`,
  output: { file: `${dist}/sw.js`, format: "esm", minify: true, sourcemap: "hidden" },
  platform: "browser",
  transform: {
    define: {
      __BYE_SHELL_BUILD__: JSON.stringify(buildHash),
      __BYE_SHELL_ASSETS__: JSON.stringify(shell),
    },
  },
});

// Security headers for asset responses (Workers static assets `_headers`; Worker-first routes set
// their own). Hashed files are immutable; the shell entry points must revalidate.
const security = [
  `Content-Security-Policy: ${[...csp, ...headerOnly].join("; ")}`,
  "Strict-Transport-Security: max-age=63072000; includeSubDomains",
  "X-Content-Type-Options: nosniff",
  "Referrer-Policy: no-referrer",
  "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()",
  "Cross-Origin-Opener-Policy: same-origin",
];

const headers = [
  "/*",
  ...security.map((h) => `  ${h}`),
  "/app.*.js",
  "  Cache-Control: public, max-age=31536000, immutable",
  "/chunk.*.js",
  "  Cache-Control: public, max-age=31536000, immutable",
  "/styles.*.css",
  "  Cache-Control: public, max-age=31536000, immutable",
  "/sw.js",
  "  Cache-Control: no-cache",
  "/index.html",
  "  Cache-Control: no-cache",
  "/",
  "  Cache-Control: no-cache",
  "",
].join("\n");

await writeFile(`${dist}/_headers`, headers);

for (const file of await readdir(dist))
  if (file.endsWith(".map")) await rename(`${dist}/${file}`, `${maps}/${file}`);

console.log(`built apps/web/dist (${buildHash}); source maps in apps/web/sourcemaps`);
