import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import React from "react";
import { Linking } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionClient,
  SessionState,
} from "../../../../packages/native-shared/src/auth/session.ts";
import type { KeyValueStore } from "../../../../packages/native-shared/src/drafts.ts";
import { InstanceRegistry } from "../../../../packages/native-shared/src/instance/registry.ts";
import { ByeApp } from "../../../../packages/native-shared/src/ui/App.tsx";
import type {
  Platform,
  WidgetSnapshot,
} from "../../../../packages/native-shared/src/ui/platform.ts";
import { testInstance } from "../../../../packages/native-shared/test/fixtures.ts";

vi.mock("react-native-webview", async () => {
  const { View } = await import("react-native");

  return {
    WebView: (props: { accessibilityLabel?: string }) => (
      <View accessibilityLabel={props.accessibilityLabel} />
    ),
  };
});

const BASE = "https://mail.bye.test";
// Deep links accept only well-formed IDs.
const T1 = "thr_0123456789abcdefghijklmn";
const OTHER = "https://other.bye.test";

const memoryKv = (): KeyValueStore => {
  const data = new Map<string, string>();

  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => void data.set(k, v),
    removeItem: async (k) => void data.delete(k),
  };
};

/** The SessionClient surface the app root drives, with its state under the test's control. */
class FakeSession {
  state: SessionState;
  private listeners = new Set<(s: SessionState) => void>();
  readonly handleCallback = vi.fn(async () => true);
  readonly beginSignIn = vi.fn(async () => ({}));
  readonly cancelSignIn = vi.fn();
  readonly logout = vi.fn(async () => "revoked" as const);
  readonly forget = vi.fn(async () => "revoked" as const);
  readonly retryPersist = vi.fn(async () => this.state);
  readonly dispose = vi.fn();

  constructor(
    readonly instanceKey: string,
    private readonly restored: SessionState,
  ) {
    this.state = { _tag: "Loading" };
  }

  subscribe(listener: (s: SessionState) => void) {
    this.listeners.add(listener);

    return () => void this.listeners.delete(listener);
  }

  set(state: SessionState) {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  async restore() {
    this.set(this.restored);

    return this.restored;
  }

  accessToken = async () => "access";
  onUnauthorized = async () => null;
}

interface Api {
  readonly me?: object | null;
  readonly imbox?: ReadonlyArray<object>;
}

const json = (status: number, body: unknown) => ({
  status,
  headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "application/json" : null) },
  text: async () => JSON.stringify(body),
});

const thread = (threadId: string, subject: string, newForYou = true) => ({
  threadId,
  subject,
  sender: "Ada",
  newForYou,
  bundleCount: 1,
  revision: 1,
});

/** The API as the root and its screens see it; anything unlisted is a 404. */
const stubApi = ({ me = ME, imbox = [thread(T1, "Lunch")] }: Api = {}) => {
  const calls: Array<string> = [];
  vi.stubGlobal("fetch", async (url: string) => {
    const { origin, pathname } = new URL(url);
    calls.push(`${origin}${pathname}`);
    if (pathname === "/v1/me") return me ? json(200, me) : json(401, { error: "unauthorized" });
    if (/\/views\/imbox$/.test(pathname))
      return json(200, { items: imbox, boundary: 1, nextCursor: null });
    if (/\/views\/\w+$/.test(pathname))
      return json(200, { items: [], boundary: 1, nextCursor: null });
    if (pathname.endsWith(`/threads/${T1}`))
      return json(200, { thread: thread(T1, "Lunch"), deliveries: [] });
    if (/\/commands$/.test(pathname)) return json(200, { ok: true });
    if (/\/widget$/.test(pathname)) return json(200, { upcoming: [], activeTimer: null });
    if (pathname === "/v1/devices") return json(200, { items: [] });
    return json(404, { error: "not_found", message: `unexpected ${pathname}` });
  });

  return calls;
};

const ME = {
  userId: "u1",
  kind: "user",
  scopes: [],
  mailboxIds: ["mbx"],
  calendarIds: ["cal"],
  organizationIds: [],
};

const setup = async ({
  saved = [BASE],
  restored = { _tag: "SignedIn", persisted: true } as SessionState,
  platform = {} as Partial<Platform>,
} = {}) => {
  const storage = memoryKv();
  const registry = new InstanceRegistry(storage);
  for (const [i, url] of saved.entries())
    await registry.save(testInstance(url), { select: i === 0 });
  const sessions: Array<FakeSession> = [];
  const published: Array<WidgetSnapshot> = [];
  const shares: Array<string | null> = [];
  const full: Platform = {
    name: "ios",
    storage,
    clientId: "bye-mobile",
    redirectUri: "bye://oauth/callback",
    // Revalidation finds the server unreachable: the saved configuration is kept (no fallback).
    probeFetch: async () => Promise.reject(new Error("offline")),
    createSession: (instance) => {
      const s = new FakeSession(instance.key, restored);
      sessions.push(s);

      return s as unknown as SessionClient;
    },
    widgets: {
      publish: (snap) => void published.push(snap),
      takePendingShare: async () => shares.shift() ?? null,
    },
    ...platform,
  };

  return { platform: full, registry, sessions, published, shares };
};

const renderApp = async (platform: Platform) => {
  await render(<ByeApp platform={platform} />);
};

describe("ByeApp", () => {
  let linkListeners: Array<(e: { url: string }) => void>;

  beforeEach(() => {
    linkListeners = [];
    vi.spyOn(Linking, "getInitialURL").mockResolvedValue(null);
    vi.spyOn(Linking, "addEventListener").mockImplementation(((
      _: string,
      l: (e: { url: string }) => void,
    ) => {
      linkListeners.push(l);

      return { remove: () => undefined };
    }) as never);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const openUrl = (url: string) => act(async () => linkListeners.forEach((l) => l({ url })));

  it("[X01] restores the saved server's session and lands on the Imbox", async () => {
    const calls = stubApi();
    const { platform } = await setup();
    await renderApp(platform);

    expect(await screen.findByRole("button", { name: "Ada: Lunch" })).toBeTruthy();
    expect(screen.getByLabelText(`Server ${BASE}`)).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Mail" })).toBeSelected();
    expect(calls.every((c) => c.startsWith(BASE))).toBe(true);
  });

  it("[A03] a signed-out session shows sign-in for the selected server", async () => {
    stubApi();
    const { platform } = await setup({ restored: { _tag: "SignedOut", reason: "expired" } });
    await renderApp(platform);

    expect(await screen.findByRole("header", { name: "Sign in to bye" })).toBeTruthy();
    expect(screen.getByText("Your session expired. Sign in again to continue.")).toBeTruthy();
  });

  it("with nothing saved and the hosted server unreachable, asks for a server", async () => {
    stubApi();
    const { platform } = await setup({ saved: [] });
    await renderApp(platform);

    expect(await screen.findByLabelText("Server address")).toBeTruthy();
    expect(
      screen.getByText("The server couldn't be reached. Check the address and your connection."),
    ).toBeTruthy();
  });

  it("opens a thread from the list and navigates with the tab bar", async () => {
    stubApi();
    const { platform } = await setup();
    await renderApp(platform);

    await fireEvent.press(await screen.findByRole("button", { name: "Ada: Lunch" }));
    expect(await screen.findByRole("header", { name: "Lunch" })).toBeTruthy();

    await fireEvent.press(screen.getByRole("tab", { name: "Write" }));
    expect(await screen.findByRole("header", { name: "New message" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Write" })).toBeSelected();
  });

  it("[X01] a bye:// deep link navigates; an OAuth callback goes only to the session", async () => {
    stubApi();
    const { platform, sessions } = await setup();
    await renderApp(platform);
    await screen.findByRole("button", { name: "Ada: Lunch" });

    await openUrl(`bye://thread/${T1}`);
    expect(await screen.findByRole("header", { name: "Lunch" })).toBeTruthy();

    await openUrl("bye://oauth/callback?code=c&state=s&iss=https%3A%2F%2Fmail.bye.test");
    expect(sessions.at(-1)!.handleCallback).toHaveBeenCalledWith(
      "bye://oauth/callback?code=c&state=s&iss=https%3A%2F%2Fmail.bye.test",
    );
    expect(screen.getByRole("header", { name: "Lunch" })).toBeTruthy();
  });

  it("[X01] a share handoff opens the composer seeded from the link", async () => {
    stubApi();
    const { platform, shares } = await setup();
    shares.push("mailto:bob@bye.test?subject=Shared");
    await renderApp(platform);

    expect(await screen.findByRole("header", { name: "New message" })).toBeTruthy();
    expect(screen.getByLabelText("To").props.value).toBe("bob@bye.test");
    expect(screen.getByLabelText("Subject").props.value).toBe("Shared");
  });

  it("[C07] publishes the widget snapshot labelled with its server, and clears it on sign-out", async () => {
    stubApi({ imbox: [thread(T1, "Lunch"), thread("t2", "Old", false)] });
    const { platform, published, sessions } = await setup();
    await renderApp(platform);

    await waitFor(() =>
      expect(published.at(-1)).toMatchObject({ unseen: 1, server: "mail.bye.test" }),
    );

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Sign out" }));
    expect(sessions.at(-1)!.logout).toHaveBeenCalledOnce();
    expect(published.at(-1)).toEqual({ nextEvent: null, timer: null, unseen: 0 });
    expect(await screen.findByText("You're signed out.")).toBeTruthy();
  });

  it("[§10] switching servers disposes the old session and remounts on the new one", async () => {
    const calls = stubApi();
    const { platform, sessions } = await setup({ saved: [BASE, OTHER] });
    await renderApp(platform);
    await screen.findByRole("button", { name: "Ada: Lunch" });

    await fireEvent.press(screen.getByRole("tab", { name: "Settings" }));
    await fireEvent.press(await screen.findByRole("button", { name: "Switch or add server" }));
    calls.length = 0;
    await fireEvent.press(await screen.findByRole("button", { name: "Use" }));

    expect(await screen.findByLabelText(`Server ${OTHER}`)).toBeTruthy();
    expect(sessions[0]!.dispose).toHaveBeenCalled();
    expect(sessions.at(-1)!.instanceKey).not.toBe(sessions[0]!.instanceKey);
    await screen.findByRole("button", { name: "Ada: Lunch" });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith(OTHER))).toBe(true);
  });

  it("an offline session keeps the app usable and says so", async () => {
    stubApi();
    const { platform } = await setup({ restored: { _tag: "Offline", detail: "no network" } });
    await renderApp(platform);

    expect(
      await screen.findByText("You're offline. bye will reconnect automatically."),
    ).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Ada: Lunch" })).toBeTruthy();
  });

  it("[X01] a notification for another saved server switches there and opens its route", async () => {
    stubApi();
    let tap: (url: string) => void = () => undefined;
    const { platform } = await setup({
      saved: [BASE, OTHER],
      platform: {
        push: {
          label: "iPhone app",
          requestToken: async () => null,
          onTokenRefresh: () => () => undefined,
          initialOpen: async () => null,
          onOpen: (l) => {
            tap = l;

            return () => undefined;
          },
        },
      },
    });
    await renderApp(platform);
    await screen.findByRole("button", { name: "Ada: Lunch" });

    await act(async () => tap(`${OTHER}/#/thread/${T1}`));
    expect(await screen.findByLabelText(`Server ${OTHER}`)).toBeTruthy();
    expect(await screen.findByRole("header", { name: "Lunch" })).toBeTruthy();
  });

  it("ignores a notification for a server that isn't saved", async () => {
    stubApi();
    let tap: (url: string) => void = () => undefined;
    const { platform } = await setup({
      platform: {
        push: {
          label: "iPhone app",
          requestToken: async () => null,
          onTokenRefresh: () => () => undefined,
          initialOpen: async () => null,
          onOpen: (l) => {
            tap = l;

            return () => undefined;
          },
        },
      },
    });
    await renderApp(platform);
    await screen.findByRole("button", { name: "Ada: Lunch" });

    await act(async () => tap(`https://stranger.test/#/thread/${T1}`));
    expect(screen.getByLabelText(`Server ${BASE}`)).toBeTruthy();
    expect(screen.queryByRole("header", { name: "Lunch" })).toBeNull();
  });
});
