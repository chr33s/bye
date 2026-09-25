import { reportError } from "@bye/native-shared/errors";
import { toast } from "./toast.ts";

// Last-resort handlers for errors no view caught. The user gets a non-blocking notice (at most one
// every few seconds); the pluggable reporter (@bye/native-shared/errors, a no-op unless a reporter
// is installed) gets a report built from the error object only, never mail content.

let lastNotice = 0;

const notify = (): void => {
  const now = Date.now();
  if (now - lastNotice < 5000) return;
  lastNotice = now;
  toast("Something went wrong. If it keeps happening, reload the page.");
};

export const installGlobalErrorHandlers = (): void => {
  window.addEventListener("error", (event) => {
    // Resource load failures (img/script) have no error object and are not app errors.
    if (!(event instanceof ErrorEvent)) return;
    reportError(event.error ?? new Error("script error"), "error");
    notify();
  });
  window.addEventListener("unhandledrejection", (event) => {
    // Aborted navigations are routine (a newer route replaced the request).
    if ((event.reason as { name?: unknown } | null)?.name === "AbortError") return;
    reportError(event.reason, "unhandledrejection");
    notify();
  });
};
