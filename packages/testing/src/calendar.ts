import { CalendarStore, type CalendarStoreConfig } from "@bye/platform-cloudflare";
import { MemoryDurableStorage } from "./sqlite.ts";
import { TestClock } from "./clock.ts";

export const CALENDAR_TEST_OWNER = "usr_owner0000000000000000";

/** Fresh CalendarDO authority over node:sqlite with a deterministic clock. */
export const makeTestCalendarStore = (
  config: Partial<CalendarStoreConfig> = {},
  start?: number,
) => {
  const storage = new MemoryDurableStorage();
  const clock = new TestClock(start);
  const store = CalendarStore.open(storage, clock, {
    ownerId: CALENDAR_TEST_OWNER,
    selfAddresses: ["me@bye.test"],
    defaultZone: "UTC",
    ...config,
  });
  let n = 0;
  const cmd = (): string => `cmd_test_${++n}`;
  return { storage, clock, store, cmd, owner: config.ownerId ?? CALENDAR_TEST_OWNER };
};
