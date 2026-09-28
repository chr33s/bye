import { describe, expect, it } from "vitest";
import { MailAfterSend } from "@bye/contracts";
import { Schema } from "effect";
import { AFTER_SEND_CHOICES, afterSendFor } from "../src/after-send.ts";

describe("after-send choices", () => {
  const now = Date.UTC(2026, 8, 28, 12);

  it("[E09] maps each choice to the contract shape the server accepts", () => {
    const decode = Schema.decodeUnknownSync(MailAfterSend);
    for (const { value } of AFTER_SEND_CHOICES) {
      const after = afterSendFor(value, now);
      if (after) expect(decode(after)).toEqual(after);
    }
    expect(afterSendFor("none", now)).toBeUndefined();
    expect(afterSendFor("follow-up-if-no-reply", now)).toEqual({
      _tag: "BubbleUp",
      at: now + 86_400_000,
      condition: "if-no-reply",
    });
    expect(afterSendFor("clear", now)).toEqual({ _tag: "ClearBubble" });
  });

  it("[E09] mark-done and pop are offered only for replies", () => {
    expect(AFTER_SEND_CHOICES.filter((c) => c.replyOnly).map((c) => c.value)).toEqual([
      "done",
      "clear",
    ]);
  });
});
