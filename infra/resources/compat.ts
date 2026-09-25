// Shared by every Worker declaration and every workerd test (no circular imports).
/**
 * The deployed compatibility date is the date the pinned test runtime (miniflare 4.20260730.0 →
 * workerd 1.20260730.1, newest supported 2026-08-06) actually exercises (§13 Stage 0). Every
 * workerd test imports this constant; bump it only together with the pinned runtime.
 */
export const COMPATIBILITY = { date: "2026-07-30", flags: [] as Array<string> } as const;

/** Newest date supported by the pinned test runtime; COMPATIBILITY.date must not exceed it. */
export const TEST_RUNTIME_MAX_DATE = "2026-08-06";
