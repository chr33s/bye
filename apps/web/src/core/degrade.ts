import { ByeApiError } from "@bye/native-shared";

// The web client's two deliberate ways of not surfacing a failed request. Everything else throws to
// the route's error state.

/**
 * A secondary panel's data (a sidebar list, quota, a settings section): when it can't load —
 * feature off, forbidden, a transient failure — the page still renders with `fallback`. An expired
 * session (401) and a navigation abort still propagate, so a panel never masks sign-out as "empty".
 */
export const degrade =
  <T>(fallback: T) =>
  (cause: unknown): T => {
    if (
      (cause instanceof ByeApiError && cause.status === 401) ||
      (cause instanceof DOMException && cause.name === "AbortError")
    )
      throw cause;

    return fallback;
  };

/**
 * Fire-and-forget side effects whose failure changes nothing the user sees (read markers, view
 * visits, best-effort cleanup, the local draft cache): swallowed by design.
 */
export const bestEffort = (): undefined => undefined;
