import { describe, expect, it } from "vitest";
import {
  extractSpeakeasyToken,
  generateSpeakeasySecret,
  normalizeSubject,
  parseMessage,
  resolveThread,
  shouldAutoReply,
  suggestDestination,
  type ThreadIndex,
} from "@bye/mail-codec";

const enc = (s: string) => new TextEncoder().encode(s.replace(/\r?\n/g, "\r\n"));

describe("threading", () => {
  const index: ThreadIndex = {
    byMessageId: (id) => ({ "root@x": "thr_a", "mid@x": "thr_a", "other@x": "thr_b" })[id],
    bySubject: (s) =>
      s === "quarterly plan"
        ? [
            { threadId: "thr_old", participants: ["bob@x.example"], lastDate: 0 },
            { threadId: "thr_s", participants: ["Bob@x.example"], lastDate: 1_000_000 },
          ]
        : [],
  };

  const base = {
    messageIdHeader: "new@x",
    inReplyTo: [],
    references: [],
    subject: "Quarterly plan",
    participants: ["bob@x.example"],
    date: 1_000_100,
  };

  it("[E11] normalizes reply and list prefixes", () => {
    expect(normalizeSubject("RE: Fwd: [team] AW: Re[2]: Quarterly  Plan")).toBe("quarterly plan");
    expect(normalizeSubject("Re: ")).toBe("");
  });

  it("[E11] prefers In-Reply-To, then the most recent known reference", () => {
    expect(
      resolveThread({ ...base, inReplyTo: ["other@x"], references: ["root@x"] }, index),
    ).toEqual({ threadId: "thr_b", via: "in-reply-to" });
    expect(
      resolveThread({ ...base, references: ["other@x", "unknown@x", "mid@x"] }, index),
    ).toEqual({ threadId: "thr_a", via: "references" });
  });

  it("[E11] only falls back to subject with a reply prefix, overlap and recency", () => {
    expect(resolveThread(base, index)).toBeUndefined();
    expect(resolveThread({ ...base, subject: "Re: Quarterly plan" }, index)).toEqual({
      threadId: "thr_s",
      via: "subject",
    });
    expect(
      resolveThread(
        { ...base, subject: "Re: Quarterly plan", participants: ["stranger@y.example"] },
        index,
      ),
    ).toBeUndefined();
    expect(
      resolveThread({ ...base, subject: "Re: Quarterly plan", date: 10 ** 12 }, index),
    ).toBeUndefined();
  });
});

describe("speakeasy", () => {
  it("[E03] matches the secret as a whole token and strips it from the subject", () => {
    const secret = generateSpeakeasySecret(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(secret).toHaveLength(10);
    expect(extractSpeakeasyToken(`Intro call [${secret.toUpperCase()}]`, secret)).toEqual({
      matched: true,
      subject: "Intro call []",
    });
    expect(extractSpeakeasyToken(`Hello ${secret}x`, secret).matched).toBe(false);
    expect(extractSpeakeasyToken(`Hello`, undefined).matched).toBe(false);
  });

  it("[E03] a rotated secret no longer matches", () => {
    const old = "oldsecret1";
    const current = "newsecret2";
    expect(extractSpeakeasyToken(`Hi ${old}`, current).matched).toBe(false);
    expect(extractSpeakeasyToken(`Hi ${current}`, current)).toEqual({
      matched: true,
      subject: "Hi",
    });
  });
});

describe("auto-reply safety", () => {
  const msg = (headers: string) => parseMessage(enc(`${headers}\nSubject: x\n\nbody`));
  it("[E22] refuses empty senders, automated mail, list traffic and other auto-replies", () => {
    expect(shouldAutoReply(msg("From: a@x.example"), "")).toEqual({
      ok: false,
      reason: "empty-envelope-sender",
    });
    expect(shouldAutoReply(msg("From: a@x.example"), "<>").ok).toBe(false);
    expect(
      shouldAutoReply(msg("From: a@x.example\nAuto-Submitted: auto-replied"), "a@x.example").ok,
    ).toBe(false);
    expect(shouldAutoReply(msg("From: a@x.example\nPrecedence: bulk"), "a@x.example").ok).toBe(
      false,
    );
    expect(
      shouldAutoReply(msg("From: a@x.example\nList-Id: <l.x.example>"), "a@x.example").ok,
    ).toBe(false);
    expect(
      shouldAutoReply(msg("From: MAILER-DAEMON@x.example"), "mailer-daemon@x.example").ok,
    ).toBe(false);
    expect(shouldAutoReply(msg("From: a@x.example\nX-Autoreply: yes"), "a@x.example").ok).toBe(
      false,
    );
    expect(shouldAutoReply(msg("From: a@x.example\nAuto-Submitted: no"), "a@x.example")).toEqual({
      ok: true,
    });
  });
});

describe("destination hints", () => {
  it("[E05] [E06] suggests feed for newsletters and paper trail for receipts", () => {
    const common = { listId: undefined, listUnsubscribe: undefined, automated: false };
    expect(
      suggestDestination({ ...common, subject: "Weekly digest", listUnsubscribe: "<mailto:u@x>" }),
    ).toBe("feed");
    expect(
      suggestDestination({
        ...common,
        subject: "Your order receipt #123",
        automated: true,
        listId: "<l>",
      }),
    ).toBe("paper-trail");
    expect(suggestDestination({ ...common, subject: "Lunch?" })).toBe("imbox");
  });
});
