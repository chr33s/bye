import { timingSafeEqual } from "@bye/domain";
// Speakeasy (E03): a rotatable subject secret that bypasses screening only. Callers must
// still apply safety, spoofing, tenant, and sending checks.

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const generateSpeakeasySecret = (
  random: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string => Array.from(random, (b) => ALPHABET[b % ALPHABET.length]).join("");

/** The canonical constant-time compare (@bye/domain), re-exported under its historical name. */
export const constantTimeEqual = timingSafeEqual;

/**
 * Check a subject for the current secret as a whole token (case-insensitive). Returns the
 * subject with the token removed so it is not displayed or quoted back in replies.
 */
export const extractSpeakeasyToken = (
  subject: string,
  secret: string | undefined,
): { readonly matched: boolean; readonly subject: string } => {
  if (!secret || secret.length < 6) return { matched: false, subject };
  const needle = secret.toLowerCase();
  let matched = false;
  const tokens = subject.split(/([^A-Za-z0-9]+)/);
  const kept = tokens.map((token) => {
    if (token.length === needle.length && constantTimeEqual(token.toLowerCase(), needle)) {
      matched = true;
      return "";
    }
    return token;
  });
  return {
    matched,
    subject: matched
      ? kept
          .join("")
          .replace(/\s+/g, " ")
          .replace(/^[\s:,-]+|[\s:,-]+$/g, "")
          .trim()
      : subject,
  };
};
