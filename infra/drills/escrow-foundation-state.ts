// Foundation state escrow (§15.6). The foundation stack keeps its own state in a local `.alchemy/`
// directory (it cannot depend on the backend it deploys). This script packs that directory,
// encrypts it with AES-256-GCM under an escrowed operator key, and uploads it as a new,
// timestamped object (never overwritten) to the private StateBackups bucket via the Cloudflare R2
// object API. `restore` reverses it into a directory for adoption.
//
// Usage:
//   BYE_ESCROW_KEY=<64 hex> CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… BYE_ESCROW_BUCKET=… \
//     node --experimental-strip-types infra/drills/escrow-foundation-state.ts upload [.alchemy]
//   BYE_ESCROW_KEY=… node --experimental-strip-types infra/drills/escrow-foundation-state.ts restore <file.bin> <out-dir>
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const MAGIC = Buffer.from("BYEESC1\u0000");

export const packDirectory = (dir: string): Buffer => {
  const files: Array<{ path: string; data: string }> = [];

  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);

      if (statSync(p).isDirectory()) walk(p);
      else files.push({ path: relative(dir, p), data: readFileSync(p, "base64") });
    }
  };

  walk(dir);

  return gzipSync(Buffer.from(JSON.stringify({ version: 1, files })));
};

export const unpackTo = (packed: Buffer, out: string): number => {
  const { files } = JSON.parse(new TextDecoder().decode(gunzipSync(packed))) as {
    files: Array<{ path: string; data: string }>;
  };

  for (const f of files) {
    if (f.path.includes("..") || f.path.startsWith("/"))
      throw new Error(`unsafe path in escrow: ${f.path}`);
    const target = join(out, f.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(f.data, "base64"));
  }

  return files.length;
};

const keyFrom = (hex: string): Buffer => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("BYE_ESCROW_KEY must be 64 hex characters");

  return Buffer.from(hex, "hex");
};

export const seal = (plain: Buffer, hexKey: string): Buffer => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(hexKey), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);

  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
};

export const open = (sealed: Buffer, hexKey: string): Buffer => {
  if (Buffer.compare(sealed.subarray(0, MAGIC.length), MAGIC) !== 0)
    throw new Error("not a bye escrow file");
  const iv = sealed.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = sealed.subarray(MAGIC.length + 12, MAGIC.length + 28);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(hexKey), iv);
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(sealed.subarray(MAGIC.length + 28)), decipher.final()]);
};

export const escrowKeyName = (sealed: Buffer, at = new Date()): string =>
  `foundation-state/${at.toISOString().replace(/[:.]/g, "-")}-${createHash("sha256").update(sealed).digest("hex").slice(0, 16)}.bin`;

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: Buffer },
) => Promise<{ status: number; text(): Promise<string> }>;

/** Upload via the Cloudflare R2 object API; the key is new each time (no overwrite). */
export const uploadEscrow = async (
  sealed: Buffer,
  env: { accountId: string; token: string; bucket: string },
  fetcher: Fetcher,
): Promise<string> => {
  const key = escrowKeyName(sealed);
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.accountId)}/r2/buckets/${encodeURIComponent(env.bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;

  const res = await fetcher(url, {
    method: "PUT",
    headers: { authorization: `Bearer ${env.token}`, "content-type": "application/octet-stream" },
    body: sealed,
  });

  if (res.status >= 300) throw new Error(`escrow upload failed: HTTP ${res.status}`);

  return key;
};

if (import.meta.main) {
  const [cmd, a, b] = process.argv.slice(2);
  const key = process.env.BYE_ESCROW_KEY ?? "";

  if (cmd === "upload") {
    const sealed = seal(packDirectory(a ?? ".alchemy"), key);

    const name = await uploadEscrow(
      sealed,
      {
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_API_TOKEN ?? "",
        bucket: process.env.BYE_ESCROW_BUCKET ?? "",
      },
      (url, init) => fetch(url, { ...init, body: new Uint8Array(init.body) }),
    );

    console.log(`escrow: uploaded ${name} (${sealed.length} bytes)`);
  } else if (cmd === "restore" && a && b) {
    console.log(`escrow: restored ${unpackTo(open(readFileSync(a), key), b)} file(s) into ${b}`);
  } else {
    console.error("usage: escrow-foundation-state.ts upload [dir] | restore <file.bin> <out-dir>");
    process.exit(2);
  }
}
