import { SKIP_WAITING } from "../lib/sw-policy.ts";
import { toast } from "./toast.ts";

// Service-worker updates. A new build installs in the background and waits; the user is offered a
// reload (never forced mid-compose), and the page reloads once the new worker takes control.

const offer = (worker: ServiceWorker): void => {
  toast("A new version of bye is available.", {
    action: { label: "Reload", run: () => worker.postMessage({ type: SKIP_WAITING }) },
  });
};

export const registerServiceWorker = async (): Promise<void> => {
  if (!("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;
  // The first install claims an uncontrolled page; only a *replacement* controller reloads.
  let reloading = false;
  const hadController = sw.controller !== null;
  sw.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  const registration = await sw.register("/sw.js");

  if (registration.waiting && sw.controller) offer(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    installing?.addEventListener("statechange", () => {
      if (installing.state === "installed" && sw.controller) offer(installing);
    });
  });
  // Long-lived tabs check for a new build hourly.
  setInterval(() => void registration.update().catch(() => undefined), 60 * 60_000);
};
