// Byte/base64url helpers shared by push adapters (no Node Buffer; Workers + Node).

export type Bytes = Uint8Array<ArrayBuffer>;
/** WebCrypto key/algorithm types derived from the runtime API (works under Node and Workers types). */
export type WebKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export type SignAlgorithm = Parameters<typeof crypto.subtle.sign>[0];

// Canonical byte helpers (@bye/domain) under the names the push adapters use.
import {
  concatBytes as concat,
  fromBase64Url as b64uDecode,
  toBase64Url as b64uEncode,
  utf8,
} from "@bye/domain";

export { b64uDecode, b64uEncode, concat, utf8 };

/** JWS compact serialization with a WebCrypto signer (ES256 → IEEE P1363 r||s, as JWS requires). */
export const signJwt = async (
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
  key: WebKey,
  algorithm: SignAlgorithm,
): Promise<string> => {
  const input = `${b64uEncode(utf8(JSON.stringify(header)))}.${b64uEncode(utf8(JSON.stringify(claims)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign(algorithm, key, utf8(input)));
  return `${input}.${b64uEncode(sig)}`;
};

/** Import a PEM (PKCS#8) private key body. */
export const pemToPkcs8 = (pem: string): Bytes =>
  b64uDecode(
    pem
      .replace(/-----(BEGIN|END) [A-Z ]+-----/g, "")
      .replace(/\s+/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  );
