import { api, ApiRequestError } from "./api.ts";
import { LOCAL_OWNER_KEY, localOwnerAction, pruneUnownedDrafts } from "./drafts.ts";

// Passkey sign-in and sign-up (A03). Credentials are WebAuthn public keys; the server issues an
// HTTP-only session cookie. Recovery uses single-use codes and never needs the locked mailbox.

const b64urlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
};

const bytesToB64url = (buffer: ArrayBuffer): string =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export const signInWithPasskey = async (): Promise<void> => {
  const { id, challenge } = await api<{ id: string; challenge: string }>(
    "POST",
    "/auth/challenge",
    { purpose: "authenticate" },
  );

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      rpId: location.hostname,
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("No passkey selected");
  const response = credential.response as AuthenticatorAssertionResponse;
  await api("POST", "/auth/passkey/login", {
    challengeId: id,
    response: {
      credentialId: credential.id,
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      authenticatorData: bytesToB64url(response.authenticatorData),
      signature: bytesToB64url(response.signature),
    },
  });
};

/** A created-but-unregistered account; lets a cancelled passkey prompt be retried (30 min). */
let pendingSignup: { address: string; userId: string; signupToken: string } | null = null;

export const signUpWithPasskey = async (
  address: string,
  displayName: string,
  turnstile: string,
  /** First account of an onboarding installation: the setup-link token instead of Turnstile. */
  bootstrap?: string,
): Promise<void> => {
  let userId: string;
  let challenge: { id: string; challenge: string };

  if (pendingSignup?.address === address) {
    userId = pendingSignup.userId;
    challenge = await api<{ id: string; challenge: string }>("POST", "/auth/signup/challenge", {
      userId,
      signupToken: pendingSignup.signupToken,
    });
  } else {
    const created = await api<{
      userId: string;
      signupToken: string;
      challenge: { id: string; challenge: string };
    }>("POST", "/auth/signup", {
      address,
      displayName,
      ...(bootstrap ? { bootstrap } : { turnstile }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });

    pendingSignup = { address, userId: created.userId, signupToken: created.signupToken };
    userId = created.userId;
    challenge = created.challenge;
  }

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(challenge.challenge),
      rp: { id: location.hostname, name: "bye" },
      user: { id: new TextEncoder().encode(userId), name: address, displayName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey creation was cancelled");
  const response = credential.response as AuthenticatorAttestationResponse;
  await api("POST", "/auth/passkey/register", {
    userId,
    challengeId: challenge.id,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
    },
  });
  pendingSignup = null;
};

/** Fresh passkey assertion on the current session for consequential actions (§10). */
export const stepUpWithPasskey = async (): Promise<void> => {
  const { id, challenge } = await api<{ id: string; challenge: string }>(
    "POST",
    "/auth/step-up/challenge",
    {},
  );

  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      rpId: location.hostname,
      userVerification: "required",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Step-up cancelled");
  const response = credential.response as AuthenticatorAssertionResponse;
  await api("POST", "/auth/step-up/passkey", {
    challengeId: id,
    response: {
      credentialId: credential.id,
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      authenticatorData: bytesToB64url(response.authenticatorData),
      signature: bytesToB64url(response.signature),
    },
  });
};

export const recoverWithCode = (address: string, code: string) =>
  api("POST", "/auth/recover", { address, code });

export const isSignedOut = (cause: unknown): boolean =>
  cause instanceof ApiRequestError && cause.status === 401;

/** Add a passkey or security key to the signed-in account (A03). Requires a recent step-up. */
export const addPasskey = async (
  userId: string,
  accountName: string,
  label: string,
): Promise<void> => {
  const { id, challenge } = await api<{ id: string; challenge: string }>(
    "POST",
    "/v1/security/passkeys/challenge",
    {},
  );

  const credential = (await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(challenge),
      rp: { id: location.hostname, name: "bye" },
      user: { id: new TextEncoder().encode(userId), name: accountName, displayName: accountName },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: { userVerification: "required" },
      attestation: "none",
      timeout: 60_000,
    },
  })) as PublicKeyCredential | null;

  if (!credential) throw new Error("Passkey creation was cancelled");
  const response = credential.response as AuthenticatorAttestationResponse;
  await api("POST", "/v1/security/passkeys", {
    challengeId: id,
    label,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      attestationObject: bytesToB64url(response.attestationObject),
    },
  });
};

export const urlBase64ToBytes = (value: string): Uint8Array<ArrayBuffer> => b64urlToBytes(value);

/** Local state a signed-out browser must not keep: offline drafts, `bye:*` keys, shell caches. */
export const clearLocalData = async (): Promise<void> => {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("bye:")) localStorage.removeItem(key);
  } catch {
    // Storage blocked: nothing was stored.
  }

  try {
    sessionStorage.clear();
  } catch {
    // ignore
  }

  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase("bye-drafts");
      // `blocked` means another tab still has it open; it is deleted once that tab lets go.
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });

  try {
    if ("caches" in globalThis)
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  } catch {
    // ignore
  }
};

const storedOwner = (): string | null => {
  try {
    return localStorage.getItem(LOCAL_OWNER_KEY);
  } catch {
    return null;
  }
};

/**
 * Bind this browser's local data to the account `/v1/me` returned. When another account's data is
 * here (its session ended without an explicit sign-out), it is wiped before anything renders.
 */
export const bindLocalOwner = async (userId: string): Promise<void> => {
  const action = localOwnerAction(storedOwner(), userId);

  if (action === "keep") return;

  if (action === "wipe") await clearLocalData();
  else await pruneUnownedDrafts().catch(() => undefined);

  try {
    localStorage.setItem(LOCAL_OWNER_KEY, userId);
  } catch {
    // Storage blocked: nothing is kept locally either.
  }
};

/**
 * The session ended (401: expired, revoked elsewhere, cookie cleared) without an explicit sign-out.
 * The browser may be shared, so the signed-in account's local data goes with it. A browser that
 * holds no bound account (already signed out) is left alone.
 */
export const onSignedOut = async (): Promise<void> => {
  if (storedOwner() !== null) await clearLocalData();
};

/**
 * Sign out of this browser: revoke the session server-side (which also clears the HTTP-only cookie
 * and closes its live sockets), wipe local data, and reload to the sign-in screen. Local data is
 * cleared even when the server can't be reached, so a shared computer never keeps the drafts; the
 * failure is then reported instead of reloading into a session that is still valid.
 */
export const logout = async (): Promise<void> => {
  let revoked = true;

  try {
    await api("POST", "/auth/logout", {});
  } catch {
    revoked = false;
  }

  await clearLocalData();

  if (!revoked)
    throw new Error(
      "Couldn't reach the server to end this session. Local data was cleared; try again when online.",
    );
  location.replace("/");
};
