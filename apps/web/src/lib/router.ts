import { type HashMatch, matchHash, type RouteTable } from "@bye/native-shared/routes";

// Hash routes for the web client, as data, in the grammar every client shares
// (@bye/native-shared/routes: literal segments, `:param`, trailing `:param?`; first match wins, so
// specific rows come first). `main.ts` maps every route name to its view with a
// `Record<RouteName, …>`, so adding a row without a handler fails to compile. Pure: testable
// without a DOM.

export const WEB_ROUTES = [
  ["mail/feed", "feed"],
  ["mail/:view?", "view"],
  ["label/:label?", "label"],
  ["unified/:view?", "unified"],
  ["thread/:threadId", "thread"],
  ["batch/:batchId", "batch"],
  ["bundle/:bundleKey", "bundle"],
  ["compose", "compose"],
  ["search", "search"],
  ["focus", "focus"],
  ["contacts", "contacts"],
  ["labels", "labels"],
  ["rules", "rules"],
  ["workflows/:boardId?", "workflows"],
  ["collections/:collectionId?", "collections"],
  ["notes", "notes"],
  ["clips", "clips"],
  ["policies", "policies"],
  ["files", "files"],
  ["settings", "settings"],
  ["security", "security"],
  ["devices", "devices"],
  ["admin", "admin"],
  ["domains/:domainId", "domain"],
  ["domains", "admin"],
  ["exports", "exports"],
  ["account/close", "close"],
  ["account", "admin"],
  ["referral", "referral"],
  ["spaces/:spaceId/threads/:threadId", "spaces"],
  ["spaces/:spaceId?", "spaces"],
  ["share", "share"],
  ["public-link", "public-link"],
  ["world/:postId?", "world"],
  ["newsletters", "newsletters"],
  ["calendar/event/:eventId?", "calendar-event"],
  ["calendar/new", "calendar-event"],
  ["calendar/planning", "calendar-planning"],
  ["calendar/context/:date?", "calendar-context"],
  ["calendar/manage", "calendar-manage"],
  ["calendar/:view?/:date?", "calendar"],
] as const satisfies RouteTable;

export type RouteName = (typeof WEB_ROUTES)[number][1];

/** Where anything unmatched (including an empty hash) lands: the Imbox. */
export const FALLBACK_ROUTE = "view" satisfies RouteName;

export type RouteMatch = HashMatch<RouteName>;

export const matchRoute = (hash: string): RouteMatch => matchHash(WEB_ROUTES, hash, FALLBACK_ROUTE);
