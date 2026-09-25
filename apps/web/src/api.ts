import { ByeApiError, ByeClient, type Method, newCommandId, queryString } from "@bye/native-shared";
import type { MailThreadSummary, MailViewPage } from "@bye/contracts";
import type { MeWire } from "@bye/native-shared/wire";

// Browser API access through the shared client (X01). The session is an HTTP-only cookie; CSRF
// protection is Origin-based on the server (browsers always send Origin on these requests). Every
// write carries a command ID. Mail content is untrusted and never rendered on this origin (§10).

export const client = new ByeClient({
  origin: location.origin,
  cookie: true,
  fetch: (url, init) => fetch(url, init as RequestInit),
});

/** Errors carry the envelope's `details` (e.g. `stepUp`), which drive the step-up retry. */
export { ByeApiError as ApiRequestError, newCommandId };

export const api = <T = unknown>(
  method: Method,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> => client.request<T>(method, path, body, signal ? { signal } : {});

/** A list route's items: every list route answers `{ items }`. */
export const list = <T = Record<string, unknown>>(
  path: string,
  signal?: AbortSignal,
): Promise<Array<T>> =>
  api<{ readonly items: ReadonlyArray<T> }>("GET", path, undefined, signal).then((r) => [
    ...r.items,
  ]);

/** Raw bodies (upload parts, photos, vCard/CSV/ICS imports). */
export const apiRaw = <T = unknown>(
  method: Method,
  path: string,
  body: Blob | ArrayBuffer | string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
): Promise<T> => client.raw<T>(method, path, body, contentType, { headers: extraHeaders });

export const query = queryString;

export type Me = MeWire;

export type Bubble =
  | { readonly _tag: "None" }
  | { readonly _tag: "Scheduled"; readonly at: number }
  | { readonly _tag: "Pinned" };

/** A mailbox view row (the MailThreadSummary contract; web tolerates older servers' missing fields). */
export type ThreadRow = Partial<typeof MailThreadSummary.Type> &
  Pick<
    typeof MailThreadSummary.Type,
    "threadId" | "subject" | "sender" | "newForYou" | "revision" | "bundleCount" | "lastActivityAt"
  > & { readonly snippet?: string };

export type ViewPage = Pick<MailViewPage, "nextCursor" | "boundary"> & {
  readonly items: ReadonlyArray<ThreadRow>;
};

/**
 * Save a binary response (attachment zips) as a download. The one web request outside ByeClient:
 * the shared client parses JSON/text bodies, and only the browser needs a Blob.
 */
export const apiDownload = async (path: string, body: unknown, filename: string): Promise<void> => {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};
