// Shared jsdom page + fake API for view tests. Import this before any src module: api.ts reads
// `location` at load, so the globals must exist first.
import type { JsonInput, JsonValue } from "@bye/native-shared/json";
import { JSDOM } from "jsdom";
import { vi } from "vitest";

export const jsdom = new JSDOM(
  '<!doctype html><body><main id="main"></main><p id="status" role="status"></p></body>',
  { url: "https://bye.example.test/", pretendToBeVisual: true },
);

const w = jsdom.window;

// Views schedule with window.setTimeout; route it through the global timers so vi.useFakeTimers()
// controls both.
Object.assign(w, {
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
});

for (const [key, value] of Object.entries({
  window: w,
  document: w.document,
  location: w.location,
  history: w.history,
  navigator: w.navigator,
  localStorage: w.localStorage,
  HTMLElement: w.HTMLElement,
  HTMLInputElement: w.HTMLInputElement,
  Node: w.Node,
  Event: w.Event,
  HashChangeEvent: w.HashChangeEvent,
  DOMParser: w.DOMParser,
  confirm: () => true,
}))
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });

export interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: JsonValue | undefined;
}

type Reply = { readonly status?: number; readonly body?: JsonInput } | undefined;

type Route = (method: string, path: string, body: JsonValue | undefined) => Reply | Promise<Reply>;

/**
 * Stub fetch with `route`; an unanswered request is a 404 error envelope. Every request is recorded
 * with its path and search, and its parsed JSON body.
 */
/** JSON request bodies are recorded parsed; raw bodies (upload parts, imports) as undefined. */
const parseJson = async (init: RequestInit): Promise<JsonValue | undefined> => {
  try {
    return JSON.parse(await new Response(init.body ?? null).text());
  } catch {
    return undefined;
  }
};

export const fakeApi = (route: Route): Array<Call> => {
  const calls: Array<Call> = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    const body = await parseJson(init);

    calls.push({ method, path: `${u.pathname}${u.search}`, body });

    const r = (await route(method, u.pathname, body)) ?? {
      status: 404,
      body: { error: { code: "NotFound", message: `No route ${method} ${u.pathname}` } },
    };

    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  return calls;
};

export const ok = (body: JsonInput): Reply => ({ body });

export const main = (): HTMLElement => w.document.getElementById("main")!;

export const live = (): string => w.document.getElementById("status")!.textContent ?? "";

export const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Poll until `check` passes (async renders chain several fetches). */
export const until = async (check: () => boolean, tries = 100): Promise<void> => {
  for (let i = 0; i < tries && !check(); i++) await settle();

  if (!check()) throw new Error("condition not reached");
};

export const byText = <T extends Element = HTMLElement>(
  selector: string,
  text: string | RegExp,
  root: ParentNode = main(),
): T => {
  const found = [...root.querySelectorAll<T>(selector)].find((el) =>
    text instanceof RegExp ? text.test(el.textContent ?? "") : el.textContent?.trim() === text,
  );

  if (!found) throw new Error(`No ${selector} with text ${String(text)}`);

  return found;
};

export const button = (text: string | RegExp, root?: ParentNode) =>
  byText<HTMLButtonElement>("button", text, root);

/** Set a form control's value and fire `input` (and `change`) like a user would. */
export const type = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  el.dispatchEvent(new w.Event("change", { bubbles: true }));
};

export const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
