import { MAIL_VIEW_NAV } from "@bye/native-shared/views";
import { api, type Me } from "./api.ts";
import { bindLocalOwner, isSignedOut, onSignedOut } from "./auth.ts";
import { announce, errorState, h, main } from "./core/dom.ts";
import { installGlobalErrorHandlers } from "./core/errors.ts";
import { registerServiceWorker } from "./core/update.ts";
import { remember, state } from "./core/state.ts";
import { matchRoute, type RouteName } from "./lib/router.ts";
import { connectLive } from "./live.ts";
import {
  renderAdmin,
  renderClose,
  renderDomain,
  renderExports,
  renderReferral,
} from "./views/admin.ts";
import { continueAuthorization, signInScreen } from "./views/auth.ts";
import { showIncomingMailBanner } from "./views/incoming-mail.ts";
import {
  renderCalendar,
  renderCalendarManage,
  renderDayContext,
  renderEventEditor,
  renderPlanning,
} from "./views/calendar.ts";
import { renderCompose } from "./views/compose.ts";
import {
  renderBatch,
  renderBundle,
  renderFeed,
  renderFocus,
  renderUnified,
  renderView,
} from "./views/mail.ts";
import {
  renderAttachments,
  renderClips,
  renderCollections,
  renderContacts,
  renderLabels,
  renderNotes,
  renderPolicies,
  renderRules,
  renderWorkflows,
} from "./views/organize.ts";
import { renderNewsletters } from "./views/newsletters.ts";
import { renderSearch } from "./views/search.ts";
import { applyTheme, renderDevices, renderSecurity, renderSettings } from "./views/settings.ts";
import {
  renderPublicLink,
  renderShare,
  renderSpace,
  renderSpaces,
  renderWorld,
} from "./views/sharing.ts";
import { renderThread } from "./views/thread.ts";

// Web/PWA client (X01). Untrusted strings only ever enter the DOM via textContent; message HTML
// renders in sandboxed iframes on the separate render origin (§10). Views live in ./views/*.

let inflight: AbortController | null = null;
let live: (() => void) | null = null;

type RouteHandler = (
  params: Readonly<Record<string, string>>,
  query: URLSearchParams,
  signal: AbortSignal,
) => Promise<void>;

/** One view per route name (lib/router.ts); a route row without a handler fails to compile. */
const HANDLERS: Readonly<Record<RouteName, RouteHandler>> = {
  view: (p, _q, signal) => renderView(p.view ?? "imbox", signal),
  label: (p, _q, signal) => renderView("label", signal, p.label),
  feed: (_p, _q, signal) => renderFeed(signal),
  unified: (p, _q, signal) => renderUnified(p.view ?? "imbox", signal),
  thread: (p, _q, signal) => renderThread(p.threadId!, signal),
  compose: (_p, q) => renderCompose(q),
  search: (_p, q, signal) => renderSearch(q, signal),
  focus: (_p, _q, signal) => renderFocus(signal),
  batch: (p, _q, signal) => renderBatch(p.batchId!, signal),
  bundle: (p, _q, signal) => renderBundle(p.bundleKey!, signal),
  contacts: (_p, q, signal) => renderContacts(q, signal),
  labels: (_p, _q, signal) => renderLabels(signal),
  rules: (_p, _q, signal) => renderRules(signal),
  workflows: (p, _q, signal) => renderWorkflows(p.boardId, signal),
  collections: (p, _q, signal) => renderCollections(p.collectionId, signal),
  notes: (_p, _q, signal) => renderNotes(signal),
  clips: (_p, q, signal) => renderClips(q, signal),
  policies: (_p, _q, signal) => renderPolicies(signal),
  files: (_p, q, signal) => renderAttachments(q, signal),
  settings: (_p, _q, signal) => renderSettings(signal),
  security: (_p, _q, signal) => renderSecurity(signal),
  devices: (_p, _q, signal) => renderDevices(signal),
  admin: (_p, q, signal) => renderAdmin(q, signal),
  domain: (p, _q, signal) => renderDomain(p.domainId!, signal),
  exports: (_p, q, signal) => renderExports(q, signal),
  close: (_p, _q, signal) => renderClose(signal),
  referral: (_p, _q, signal) => renderReferral(signal),
  spaces: (p, _q, signal) =>
    p.spaceId ? renderSpace(p.spaceId, p.threadId, signal) : renderSpaces(signal),
  share: (_p, q, signal) => renderShare(q, signal),
  "public-link": (_p, q, signal) => renderPublicLink(q, signal),
  world: (p, _q, signal) => renderWorld(p.postId, signal),
  newsletters: (_p, _q, signal) => renderNewsletters(signal),
  calendar: (p, q, signal) => renderCalendar(q, signal, p.view, p.date),
  "calendar-event": (p, q, signal) => renderEventEditor(p.eventId, q, signal),
  "calendar-planning": (_p, _q, signal) => renderPlanning(signal),
  "calendar-context": (p, _q, signal) => renderDayContext(p.date ?? "", signal),
  "calendar-manage": (_p, _q, signal) => renderCalendarManage(signal),
};

const dispatch = (signal: AbortSignal): Promise<void> => {
  const { name, params, query } = matchRoute(location.hash);
  return HANDLERS[name](params, query, signal);
};

const route = async (): Promise<void> => {
  inflight?.abort();
  inflight = new AbortController();
  const signal = inflight.signal;
  const { path } = matchRoute(location.hash);
  document.querySelectorAll("nav a").forEach((a) => a.removeAttribute("aria-current"));
  document.querySelector(`nav a[href="#${path}"]`)?.setAttribute("aria-current", "page");
  try {
    if (!state.me) {
      const me = await api<Me>("GET", "/v1/me", undefined, signal);
      // Another account's offline drafts never reach this one (shared browser).
      await bindLocalOwner(me.userId);
      state.me = me;
      if (continueAuthorization()) return;
      state.mailboxId = state.me.mailboxIds[0] ?? null;
      state.calendarId = state.me.calendarIds[0] ?? null;
      live?.();
      live = state.mailboxId ? connectLive(state.mailboxId, () => void route()) : null;
      // Optional "Set up incoming email" offer for the onboarding zone (never blocks the app).
      void showIncomingMailBanner().catch(() => undefined);
    }
    await dispatch(signal);
    main().focus({ preventScroll: true });
  } catch (error) {
    if (signal.aborted) return;
    if (isSignedOut(error)) {
      state.me = null;
      state.mailboxId = null;
      state.calendarId = null;
      live?.();
      live = null;
      await onSignedOut();
    }
    main().replaceChildren(
      isSignedOut(error) ? signInScreen(() => void route()) : errorState(error, () => void route()),
    );
  }
};

const shortcuts = (event: KeyboardEvent): void => {
  const target = event.target as HTMLElement;
  if (
    target.closest("input, textarea, select, [contenteditable]") ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  )
    return;
  const view = MAIL_VIEW_NAV.find((n) => n.key === event.key);
  if (view) location.hash = `#/mail/${view.view}`;
  else if (event.key === "c") location.hash = "#/compose";
  else if (event.key === "/") {
    event.preventDefault();
    location.hash = "#/search";
  } else if (event.key === "g") location.hash = "#/calendar";
  else if (event.key === "r") location.hash = "#/focus";
  else if (event.key === "?")
    announce(
      "Shortcuts: i f p s l a b t views · c write · / search · g calendar · r focus & reply",
    );
};

const boot = (): void => {
  installGlobalErrorHandlers();
  applyTheme(remember.get("theme"));
  // PWA share target (manifest `share_target` → "/?subject&text&url"): open compose prefilled.
  const shared = new URLSearchParams(location.search);
  if (shared.has("subject") || shared.has("text") || shared.has("url"))
    history.replaceState(null, "", `/#/compose?${shared.toString()}`);
  const nav = document.getElementById("nav")!;
  nav.replaceChildren(
    ...MAIL_VIEW_NAV.map((n) =>
      h(
        "a",
        { href: `#/mail/${n.view}`, ...(n.key ? { "aria-keyshortcuts": n.key } : {}) },
        n.label,
      ),
    ),
    h("a", { href: "#/calendar", "aria-keyshortcuts": "g" }, "Calendar"),
    h("a", { href: "#/search", "aria-keyshortcuts": "/" }, "Search"),
    h("a", { href: "#/contacts" }, "Contacts"),
    h("a", { href: "#/spaces" }, "Shared"),
    h("a", { href: "#/world" }, "Blog"),
    h("a", { href: "#/newsletters" }, "Newsletters"),
    h("a", { href: "#/settings" }, "Settings"),
    h("a", { href: "#/compose", "aria-keyshortcuts": "c", class: "primary" }, "Write"),
  );
  window.addEventListener("hashchange", () => void route());
  document.addEventListener("keydown", shortcuts);
  window.addEventListener("online", () => announce("Back online"));
  window.addEventListener("offline", () => announce("Offline — drafts are saved on this device"));
  void registerServiceWorker().catch(() => undefined);
  void route();
};

boot();
