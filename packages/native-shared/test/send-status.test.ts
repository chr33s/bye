import { describe, expect, it } from "vitest";
import { describeSendJobs, sendJobsSettled } from "../src/send-status.ts";

describe("native send outcomes", () => {
  it("[E18] shows per-recipient outcomes and never presents acceptance or Unknown as delivery", () => {
    expect(sendJobsSettled([{ state: "submitting" }])).toBe(false);
    expect(describeSendJobs([{ state: "unknown" }])[0]).toContain("may have accepted");
    expect(describeSendJobs([{ state: "accepted" }])[0]).toContain("not proof of inbox delivery");
    expect(
      describeSendJobs([
        {
          state: "accepted",
          outcomes: [
            { address: "a@x.com", outcome: "delivered", detail: null },
            { address: "b@x.com", outcome: "bounced", detail: "550 no such user" },
          ],
        },
      ]),
    ).toEqual([
      "a@x.com: delivered to the recipient's server",
      "b@x.com: bounced (550 no such user)",
    ]);
    expect(
      describeSendJobs([{ state: "rejected", failure: { detail: "sender not authorized" } }]),
    ).toEqual(["Not sent: sender not authorized"]);
  });
});
