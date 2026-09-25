import {
  concatBytes,
  fromBase64Url,
  sha256,
  timingSafeEqual,
  toBase64Url,
  utf8,
} from "./crypto.ts";

// Minimal WebAuthn relying party (A03): "none" attestation registration and ES256 assertions.

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | Array<CborValue>
  | Map<CborValue, CborValue>;

/** Decode a single CBOR item (RFC 8949 subset used by WebAuthn: no tags, no indefinite lengths). */
export const cborDecode = (bytes: Uint8Array): { value: CborValue; offset: number } => {
  let offset = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (n: number) => {
    if (offset + n > bytes.length) throw new Error("cbor: truncated");
  };
  const readLength = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return (need(1), view.getUint8(offset++));
    if (info === 25) {
      need(2);
      const v = view.getUint16(offset);
      offset += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = view.getUint32(offset);
      offset += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = view.getBigUint64(offset);
      offset += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("cbor: integer too large");
      return Number(v);
    }
    throw new Error("cbor: unsupported length encoding");
  };
  const item = (depth: number): CborValue => {
    if (depth > 16) throw new Error("cbor: nesting too deep");
    need(1);
    const initial = view.getUint8(offset++);
    const major = initial >> 5;
    const info = initial & 31;
    switch (major) {
      case 0:
        return readLength(info);
      case 1:
        return -1 - readLength(info);
      case 2: {
        const n = readLength(info);
        need(n);
        const out = bytes.slice(offset, offset + n);
        offset += n;
        return out;
      }
      case 3: {
        const n = readLength(info);
        need(n);
        const out = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
          bytes.subarray(offset, offset + n),
        );
        offset += n;
        return out;
      }
      case 4: {
        const n = readLength(info);
        const arr: Array<CborValue> = [];
        for (let i = 0; i < n; i++) arr.push(item(depth + 1));
        return arr;
      }
      case 5: {
        const n = readLength(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          map.set(k, item(depth + 1));
        }
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error("cbor: unsupported simple value");
      default:
        throw new Error("cbor: tags unsupported");
    }
  };
  const value = item(0);
  return { value, offset };
};

/** Encode the CBOR subset above. Used for fixtures and tests. */
export const cborEncode = (value: CborValue): Uint8Array<ArrayBuffer> => {
  const head = (major: number, n: number): Uint8Array<ArrayBuffer> => {
    if (n < 24) return new Uint8Array([(major << 5) | n]);
    if (n < 256) return new Uint8Array([(major << 5) | 24, n]);
    if (n < 65536) return new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
    return new Uint8Array([
      (major << 5) | 26,
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
    ]);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const b = utf8(value);
    return concatBytes(head(3, b.length), b);
  }
  if (value instanceof Uint8Array) return concatBytes(head(2, value.length), value);
  if (Array.isArray(value)) return concatBytes(head(4, value.length), ...value.map(cborEncode));
  if (value instanceof Map)
    return concatBytes(
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cborEncode(k), cborEncode(v)]),
    );
  if (value === false) return new Uint8Array([0xf4]);
  if (value === true) return new Uint8Array([0xf5]);
  if (value === null) return new Uint8Array([0xf6]);
  throw new Error("cbor: unsupported value");
};

/** P-256 public key in JWK form (structural; avoids depending on a lib-specific global). */
export interface EcPublicJwk {
  readonly kty: "EC";
  readonly crv: "P-256";
  readonly x: string;
  readonly y: string;
  readonly ext?: boolean;
}

export interface AuthenticatorData {
  readonly rpIdHash: Uint8Array;
  readonly userPresent: boolean;
  readonly userVerified: boolean;
  readonly signCount: number;
  readonly credentialId: Uint8Array | undefined;
  readonly cosePublicKey: Map<CborValue, CborValue> | undefined;
}

export const parseAuthenticatorData = (data: Uint8Array): AuthenticatorData => {
  if (data.length < 37) throw new WebAuthnError("authenticator data too short");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const flags = data[32]!;
  const attested = (flags & 0x40) !== 0;
  let credentialId: Uint8Array | undefined;
  let cosePublicKey: Map<CborValue, CborValue> | undefined;
  if (attested) {
    if (data.length < 55) throw new WebAuthnError("attested credential data truncated");
    const idLen = view.getUint16(53);
    credentialId = data.slice(55, 55 + idLen);
    const key = cborDecode(data.subarray(55 + idLen)).value;
    if (!(key instanceof Map)) throw new WebAuthnError("credential public key is not a COSE map");
    cosePublicKey = key;
  }
  return {
    rpIdHash: data.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount: view.getUint32(33),
    credentialId,
    cosePublicKey,
  };
};

export class WebAuthnError extends Error {
  override readonly name = "WebAuthnError";
}

export interface RelyingParty {
  readonly rpId: string;
  readonly origins: ReadonlyArray<string>;
  readonly requireUserVerification: boolean;
}

const checkClientData = (
  clientDataJSON: Uint8Array,
  type: string,
  challenge: string,
  rp: RelyingParty,
) => {
  let parsed: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    throw new WebAuthnError("clientDataJSON is not JSON");
  }
  if (parsed.type !== type) throw new WebAuthnError("unexpected ceremony type");
  if (typeof parsed.challenge !== "string" || !timingSafeEqual(parsed.challenge, challenge))
    throw new WebAuthnError("challenge mismatch");
  if (typeof parsed.origin !== "string" || !rp.origins.includes(parsed.origin))
    throw new WebAuthnError("origin not allowed");
  if (parsed.crossOrigin === true) throw new WebAuthnError("cross-origin ceremony rejected");
};

const checkAuthData = async (auth: AuthenticatorData, rp: RelyingParty) => {
  const expected = await sha256(rp.rpId);
  if (toBase64Url(auth.rpIdHash) !== toBase64Url(expected))
    throw new WebAuthnError("rpId hash mismatch");
  if (!auth.userPresent) throw new WebAuthnError("user presence required");
  if (rp.requireUserVerification && !auth.userVerified)
    throw new WebAuthnError("user verification required");
};

export interface RegisteredPasskey {
  readonly credentialId: string;
  readonly publicKeyJwk: EcPublicJwk;
  readonly signCount: number;
}

/** Verify a registration ceremony with "none" attestation and an ES256 (P-256) credential. */
export const verifyRegistration = async (
  input: { readonly clientDataJSON: string; readonly attestationObject: string },
  challenge: string,
  rp: RelyingParty,
): Promise<RegisteredPasskey> => {
  checkClientData(fromBase64Url(input.clientDataJSON), "webauthn.create", challenge, rp);
  const att = cborDecode(fromBase64Url(input.attestationObject)).value;
  if (!(att instanceof Map)) throw new WebAuthnError("attestation object malformed");
  if (att.get("fmt") !== "none") throw new WebAuthnError("only 'none' attestation is accepted");
  const authData = att.get("authData");
  if (!(authData instanceof Uint8Array)) throw new WebAuthnError("authData missing");
  const auth = parseAuthenticatorData(authData);
  await checkAuthData(auth, rp);
  if (!auth.credentialId || !auth.cosePublicKey) throw new WebAuthnError("no attested credential");
  const k = auth.cosePublicKey;
  if (k.get(1) !== 2 || k.get(3) !== -7 || k.get(-1) !== 1)
    throw new WebAuthnError("only ES256 P-256 credentials are supported");
  const x = k.get(-2);
  const y = k.get(-3);
  if (
    !(x instanceof Uint8Array) ||
    !(y instanceof Uint8Array) ||
    x.length !== 32 ||
    y.length !== 32
  )
    throw new WebAuthnError("invalid EC point");
  const publicKeyJwk: EcPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(x),
    y: toBase64Url(y),
    ext: true,
  };
  // Import to validate the point is on the curve.
  await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return { credentialId: toBase64Url(auth.credentialId), publicKeyJwk, signCount: auth.signCount };
};

/** Convert an ASN.1 DER ECDSA signature to IEEE P1363 r||s as WebCrypto expects. */
export const derToRaw = (der: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (der[0] !== 0x30) throw new WebAuthnError("signature is not DER");
  let o = 2;
  if (der[1]! & 0x80) o = 2 + (der[1]! & 0x7f);
  const readInt = (): Uint8Array => {
    if (der[o] !== 0x02) throw new WebAuthnError("malformed DER integer");
    const len = der[o + 1]!;
    let v = der.subarray(o + 2, o + 2 + len);
    o += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    if (v.length > 32) throw new WebAuthnError("integer too long");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return concatBytes(readInt(), readInt());
};

export const rawToDer = (raw: Uint8Array): Uint8Array<ArrayBuffer> => {
  const int = (v: Uint8Array) => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.subarray(i);
    if (b[0]! & 0x80) b = concatBytes(new Uint8Array([0]), b);
    return concatBytes(new Uint8Array([0x02, b.length]), b);
  };
  const body = concatBytes(int(raw.subarray(0, 32)), int(raw.subarray(32)));
  return concatBytes(new Uint8Array([0x30, body.length]), body);
};

/** Verify an assertion. Returns the new signature counter; rejects counter regression (cloned authenticator). */
export const verifyAssertion = async (
  input: {
    readonly clientDataJSON: string;
    readonly authenticatorData: string;
    readonly signature: string;
  },
  challenge: string,
  rp: RelyingParty,
  stored: { readonly publicKeyJwk: EcPublicJwk; readonly signCount: number },
): Promise<{ readonly signCount: number }> => {
  const clientData = fromBase64Url(input.clientDataJSON);
  checkClientData(clientData, "webauthn.get", challenge, rp);
  const authBytes = fromBase64Url(input.authenticatorData);
  const auth = parseAuthenticatorData(authBytes);
  await checkAuthData(auth, rp);
  const key = await crypto.subtle.importKey(
    "jwk",
    stored.publicKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const signed = concatBytes(authBytes, await sha256(clientData));
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    derToRaw(fromBase64Url(input.signature)),
    signed,
  );
  if (!ok) throw new WebAuthnError("signature invalid");
  if ((auth.signCount !== 0 || stored.signCount !== 0) && auth.signCount <= stored.signCount) {
    throw new WebAuthnError("signature counter did not increase");
  }
  return { signCount: auth.signCount };
};
