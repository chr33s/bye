import type { KernelClock } from "@bye/platform-cloudflare";

/** Deterministic clock and ID source for authority tests (§7.4 Tests). */
export class TestClock implements KernelClock {
  private counter = 0;
  constructor(public current = Date.UTC(2026, 8, 25, 12, 0, 0)) {}
  readonly now = (): number => this.current;
  readonly id = (prefix: string): string =>
    `${prefix}_${(++this.counter).toString(36).padStart(20, "0")}`;
  advance(ms: number): number {
    this.current += ms;

    return this.current;
  }
}
