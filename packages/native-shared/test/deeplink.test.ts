import { describe, expect, it } from "vitest";
import { deepLinkToRoute } from "../src/deeplink.ts";
import vectors from "../deeplink-vectors.json" with { type: "json" };

describe("native deep links", () => {
  it("[X01] maps bye:// and mailto: links to PWA routes and rejects everything else", () => {
    for (const v of vectors as ReadonlyArray<{ input: string; route: string | null }>) {
      expect({ input: v.input, route: deepLinkToRoute(v.input) }).toEqual(v);
    }
    expect(deepLinkToRoute("mailto:%ZZ")).toBeNull();
    expect(deepLinkToRoute("bye://mail/%ZZ")).toBeNull();
  });
});

import { parseRoute } from "../src/routes.ts";

describe("native routes", () => {
  it("[X01] share-sheet links open the composer with the shared text and URL", () => {
    const route = deepLinkToRoute(
      "bye://compose?text=Look%20at%20this&url=https%3A%2F%2Fexample.net%2Fa&subject=FYI",
    );
    expect(parseRoute(route!)).toEqual({
      screen: "compose",
      subject: "FYI",
      text: "Look at this\n\nhttps://example.net/a",
    });
    expect(parseRoute(deepLinkToRoute("bye://thread/thr_0123456789abcdefghjk")!)).toEqual({
      screen: "thread",
      threadId: "thr_0123456789abcdefghjk",
    });
    expect(parseRoute("#/mail/bogus")).toEqual({ screen: "mail", view: "imbox" });
  });
});
