import { Schema } from "effect";
import { decode } from "./schemas.ts";
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Kept outside Build Output/artifacts and always removed, including on upload failure. */
export const withSecretsFile = async <T>(
  secrets: Readonly<Record<string, string>>,
  use: (path: string) => Promise<T>,
): Promise<T> => {
  for (const key of Object.keys(decode(Schema.Record(Schema.String, Schema.String), secrets))) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("invalid secret binding");

    if (/^(CLOUDFLARE_API_TOKEN|BYE_STATE_TOKEN)$/.test(key))
      throw new Error("management credentials cannot be Worker bindings");
  }

  const directory = mkdtempSync(join(tmpdir(), "bye-cf-secrets-"));
  chmodSync(directory, 0o700);

  try {
    const path = join(directory, "bindings.json");
    writeFileSync(path, JSON.stringify(secrets), { mode: 0o600, flag: "wx" });

    return await use(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
