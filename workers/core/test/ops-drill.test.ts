import { describe, expect, it } from "vitest";
import { runDataRestoreDrill } from "../../../infra/drills/data-restore.ts";

// §12 restore drills, run in real workerd (Miniflare): mailbox, shared resource, calendar and a
// complete export restore from a checkpoint, and erasure tombstones re-erase restored data.
describe("data restore drills", () => {
  it("[§12] mailbox, shared, calendar and export restore; erased data is not resurrected", async () => {
    const checks = await runDataRestoreDrill();
    expect(checks.map((c) => c.drill).sort()).toEqual([
      "calendar",
      "export",
      "mailbox",
      "shared",
      "tombstones",
    ]);

    for (const c of checks) expect(c.ok, `${c.drill}: ${c.detail}`).toBe(true);
  }, 180_000);
});
