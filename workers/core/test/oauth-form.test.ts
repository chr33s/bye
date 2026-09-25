import { describe, expect, it } from "vitest";
import { OAUTH_FORM_MAX_BYTES, oauthForm, readTextCapped } from "../src/routes/common.ts";

// OAuth token/revocation forms are read with a byte cap, whatever content-length claims.

const streamed = (text: string, headers: Record<string, string> = {}) =>
  new Request("https://app.bye.test/oauth/token", {
    method: "POST",
    headers,
    // A stream body has no content-length, so only the reader's cap bounds it.
    body: new Blob([text]).stream(),
    duplex: "half",
  } as RequestInit);

describe("[§10] capped OAuth form bodies", () => {
  it("parses a small form and refuses an oversized one without buffering it", async () => {
    const form = await oauthForm(streamed("grant_type=refresh_token&refresh_token=abc"));
    expect(form.get("grant_type")).toBe("refresh_token");
    const huge = `grant_type=x&pad=${"a".repeat(OAUTH_FORM_MAX_BYTES * 4)}`;
    expect(await readTextCapped(streamed(huge), OAUTH_FORM_MAX_BYTES)).toBeNull();
    expect([...(await oauthForm(streamed(huge))).keys()]).toEqual([]);
    // A declared length over the cap is refused before reading.
    expect(
      await readTextCapped(
        new Request("https://app.bye.test/x", {
          method: "POST",
          body: "short",
          headers: { "content-length": String(OAUTH_FORM_MAX_BYTES + 1) },
        }),
        OAUTH_FORM_MAX_BYTES,
      ),
    ).toBeNull();
  });

  it("reads JSON bodies under the same cap", async () => {
    const form = await oauthForm(
      streamed(JSON.stringify({ client_id: "bye-desktop" }), {
        "content-type": "application/json",
      }),
    );
    expect(form.get("client_id")).toBe("bye-desktop");
  });
});
