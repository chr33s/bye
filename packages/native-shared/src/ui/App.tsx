import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Platform as RNPlatform,
  Pressable,
  SafeAreaView,
  StatusBar,
  Text,
  View,
} from "react-native";
import { isAuthCallback } from "../auth/authorize.ts";
import type { SessionClient, SessionState } from "../auth/session.ts";
import { toLocalDate, ymd } from "../calendar-form.ts";
import { ByeClient, countNewForYou, type FetchLike, widgetSnapshot } from "../client.ts";
import { deepLinkToRoute } from "../deeplink.ts";
import { DraftStore } from "../drafts.ts";
import {
  probeInstance,
  sameCredentialDestinations,
  type ValidatedInstance,
} from "../instance/discovery.ts";
import { parseInstanceHandoff } from "../instance/handoff.ts";
import {
  accountScope,
  clearInstanceState,
  HOSTED_INSTANCE_URL,
  InstanceConflictError,
  InstanceRegistry,
  scopedStore,
} from "../instance/registry.ts";
import { DEFAULT_ROUTE, type NativeRoute, parseRoute } from "../routes.ts";
import { sealedStore } from "../sealed-store.ts";
import type { MeWire } from "../wire.ts";
import { Calendar } from "./Calendar.tsx";
import { Composer } from "./Composer.tsx";
import { CoverPanel } from "./CoverPanel.tsx";
import { ErrorBoundary, installNativeErrorHandler } from "./errors.tsx";
import { EventEditor } from "./EventEditor.tsx";
import { MailList } from "./MailList.tsx";
import { Planning } from "./Planning.tsx";
import type { Platform } from "./platform.ts";
import { Search } from "./Search.tsx";
import { describeProbe, Servers } from "./Servers.tsx";
import { Settings } from "./Settings.tsx";
import { describeSession, SignIn } from "./SignIn.tsx";
import { Thread } from "./Thread.tsx";
import { colors, s } from "./theme.ts";

// Native app root shared by iOS, Android, macOS and Windows (X01). Genuinely native screens over the
// same /v1 contracts as web; message HTML is the only web content, sandboxed on MAIL_ORIGIN.
//
// One build serves any compatible instance (spec §10 Instance selection). Everything below the server
// picker runs inside one explicit context — a validated instance and, once signed in, one account
// on it. Switching creates a new session and remounts the screens; work started in the old context
// can finish, but its results never reach the new one.

const NAV: ReadonlyArray<readonly [string, NativeRoute]> = [
  ["Mail", DEFAULT_ROUTE],
  ["Calendar", { screen: "calendar" }],
  ["Plan", { screen: "planning" }],
  ["Search", { screen: "search", q: "" }],
  ["Write", { screen: "compose" }],
  ["Settings", { screen: "settings" }],
];

const nativeFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

const hasSession = (state: SessionState) =>
  state._tag === "SignedIn" || state._tag === "NotPersisted" || state._tag === "Offline";

const EMPTY_WIDGET = { nextEvent: null, timer: null, unseen: 0 } as const;

const hostOf = (baseUrl: string) => baseUrl.replace(/^https:\/\//, "");

interface ServersView {
  readonly initialUrl?: string | null;
  readonly notice?: string | null;
}

const ByeAppRoot = ({ platform }: { platform: Platform }) => {
  const registry = useMemo(() => new InstanceRegistry(platform.storage), [platform.storage]);
  const [booted, setBooted] = useState(false);
  const [saved, setSaved] = useState<ReadonlyArray<ValidatedInstance>>([]);
  const [instance, setInstance] = useState<ValidatedInstance | null>(null);
  const [session, setSession] = useState<SessionClient | undefined>(undefined);
  const [sessionState, setSessionState] = useState<SessionState>({ _tag: "Loading" });
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<MeWire | null>(null);
  const [servers, setServers] = useState<ServersView | null>(null);
  const [route, setRoute] = useState<NativeRoute>(DEFAULT_ROUTE);
  const [refreshKey, setRefreshKey] = useState(0);
  const sessionRef = useRef<SessionClient | undefined>(undefined);

  const probe = useCallback(
    (url: string) =>
      probeInstance(url, {
        fetch: platform.probeFetch,
        clientId: platform.clientId,
        redirectUri: platform.redirectUri,
      }),
    [platform],
  );

  // Launch: the saved selection, never a substitute. Hosted is offered only when nothing is saved.
  useEffect(() => {
    let live = true;
    void (async () => {
      const list = await registry.list();
      const selected = await registry.selected();
      if (!live) return;
      setSaved(list);
      if (selected) setInstance(selected);
      else if (list.length > 0) setServers({});
      else {
        const hosted = await probe(HOSTED_INSTANCE_URL);
        if (!live) return;
        if (hosted._tag === "Valid") {
          await registry.save(hosted.instance, { select: true });
          setSaved(await registry.list());
          setInstance(hosted.instance);
        } else setServers({ notice: describeProbe(hosted) });
      }
      setBooted(true);
    })();
    return () => {
      live = false;
    };
  }, [registry, probe]);

  // One session per selected instance. Leaving it cancels any sign-in attempt (late callbacks are
  // refused) and ignores in-flight results; stored credentials stay for switching back.
  useEffect(() => {
    setMe(null);
    setRoute(DEFAULT_ROUTE);
    if (!instance) {
      sessionRef.current = undefined;
      setSession(undefined);
      return;
    }
    const next = platform.createSession?.(instance);
    sessionRef.current = next;
    setSession(next);
    setReady(!next);
    setSessionState(next ? next.state : { _tag: "SignedIn", persisted: true });
    const unsubscribe = next?.subscribe(setSessionState);
    void next?.restore().finally(() => {
      if (sessionRef.current === next) setReady(true);
    });
    // Revalidate quietly. Unreachable keeps the saved configuration (no fallback); a changed
    // issuer or credential endpoint stops credential use until the user confirms it again.
    void probe(instance.baseUrl).then((r) => {
      if (sessionRef.current !== next) return;
      if (r._tag === "Valid" && !sameCredentialDestinations(r.instance, instance)) {
        next?.dispose();
        setInstance(null);
        setServers({
          initialUrl: instance.baseUrl,
          notice: "This server's sign-in configuration changed. Review it and sign in again.",
        });
      }
    });
    return () => {
      unsubscribe?.();
      next?.dispose();
      platform.widgets?.publish(EMPTY_WIDGET);
    };
  }, [instance, platform, probe]);

  const client = useMemo(
    () =>
      instance
        ? new ByeClient({
            origin: instance.baseUrl,
            fetch: nativeFetch,
            ...(session
              ? {
                  auth: {
                    token: () => session.accessToken(),
                    onUnauthorized: () => session.onUnauthorized(),
                  },
                }
              : {}),
          })
        : null,
    [instance, session],
  );

  const scope = instance && me ? accountScope(instance.key, me.userId) : null;
  // Drafts are mail content: sealed with the secure-store key, and cleared with the scope on sign-out.
  const drafts = useMemo(() => {
    if (!scope || !instance) return null;
    const scoped = scopedStore(platform.storage, scope, instance.key);
    return new DraftStore(platform.draftKey ? sealedStore(scoped, platform.draftKey) : scoped);
  }, [platform.storage, platform.draftKey, scope, instance]);

  const open = useCallback((url: string | null) => {
    const hash = url ? deepLinkToRoute(url) : null;
    if (hash) setRoute(parseRoute(hash));
  }, []);

  // Three distinct kinds of link: an instance handoff (validate + confirm, never auto-save), an
  // OAuth callback (only the current session's attempt, never navigation), or navigation.
  const onUrl = useRef<(url: string | null | undefined) => Promise<void>>(async () => undefined);
  onUrl.current = async (url) => {
    if (!url) return;
    const handoff = parseInstanceHandoff(url);
    if (handoff._tag === "AddInstance") return setServers({ initialUrl: handoff.url });
    if (handoff._tag === "Rejected")
      return setServers({ notice: "That server link isn't valid, so nothing was added." });
    if (isAuthCallback(url)) {
      await sessionRef.current?.handleCallback(url);
      return;
    }
    open(url);
  };

  useEffect(() => {
    if (!booted) return;
    const handle = (url: string | null | undefined) => void onUrl.current(url);
    void Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", ({ url }) => handle(url));
    void platform.urls?.initial().then(handle);
    const unsubscribeUrls = platform.urls?.subscribe(handle);
    return () => {
      sub.remove();
      unsubscribeUrls?.();
    };
  }, [booted, platform.urls]);

  // Share-extension handoff and refresh on foreground.
  useEffect(() => {
    if (!booted) return;
    const takeShare = () => void platform.widgets?.takePendingShare().then(open);
    takeShare();
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      setRefreshKey((k) => k + 1);
      takeShare();
    });
    return () => sub.remove();
  }, [booted, platform.widgets, open]);

  useEffect(() => {
    if (!ready || !client) return;
    if (session && !hasSession(sessionState)) {
      setMe(null);
      return;
    }
    let live = true;
    client.me().then(
      (m) => live && setMe(m),
      () => live && setMe(null),
    );
    return () => {
      live = false;
    };
  }, [client, ready, session, sessionState]);

  // Home-screen widget: next event, the active timer (C07) and the Imbox's new-for-you count,
  // refreshed on foreground, labelled with its server. Results from a context the user has left
  // are dropped. A failed count read shows 0 rather than hiding the event.
  useEffect(() => {
    const calendarId = me?.calendarIds[0];
    const mailboxId = me?.mailboxIds[0];
    if (!platform.widgets) return;
    if ((session && !hasSession(sessionState)) || !calendarId || !client || !instance) {
      platform.widgets.publish(EMPTY_WIDGET);
      return;
    }
    let live = true;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const unseen = mailboxId
      ? client.view(mailboxId, "imbox").then(countNewForYou, () => 0)
      : Promise.resolve(0);
    Promise.all([client.widget(calendarId, tz), unseen]).then(
      ([w, count]) =>
        live &&
        platform.widgets?.publish({
          ...widgetSnapshot(w, count),
          server: hostOf(instance.baseUrl),
        }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, instance, me, platform.widgets, refreshKey, session, sessionState]);

  const refreshSaved = async () => setSaved(await registry.list());

  const confirmInstance = async (next: ValidatedInstance) => {
    const before = await registry.list();
    let invalidated: ReadonlyArray<string>;
    try {
      ({ invalidated } = await registry.save(next, { select: true }));
    } catch (error) {
      if (error instanceof InstanceConflictError)
        throw new Error(
          "Another saved server already uses this sign-in service with different settings, so this one wasn't added.",
        );
      throw error;
    }
    // Destinations changed: drop the old credentials without sending them anywhere.
    for (const key of invalidated) {
      const old = before.find((i) => i.key === key);
      if (old) await platform.createSession?.(old).forget({ revoke: false });
      await clearInstanceState(platform.storage, key);
    }
    await refreshSaved();
    setServers(null);
    setInstance(next);
  };

  const selectInstance = async (key: string) => {
    await registry.select(key);
    setServers(null);
    setInstance(await registry.get(key));
  };

  const removeInstance = async (target: ValidatedInstance): Promise<string> => {
    const current = target.key === instance?.key;
    const s = current ? sessionRef.current : platform.createSession?.(target);
    const outcome = s ? await s.forget() : "revoked";
    await clearInstanceState(platform.storage, target.key);
    await registry.remove(target.key);
    await refreshSaved();
    if (current) setInstance(null);
    return outcome === "unconfirmed"
      ? `Removed ${target.baseUrl} from this device. The server couldn't be reached to confirm sign-out.`
      : outcome === "local-only"
        ? `Removed ${target.baseUrl} from this device. That server doesn't support remote sign-out.`
        : `Removed ${target.baseUrl} from this device.`;
  };

  const signOut = async () => {
    const leaving = scope;
    platform.widgets?.publish(EMPTY_WIDGET);
    setSessionState({ _tag: "SignedOut", reason: "logged-out" });
    setMe(null);
    if (session) await session.logout();
    if (leaving) await scopedStore(platform.storage, leaving).clear();
  };

  if (!booted) return <SafeAreaView style={s.safe} />;
  if (servers || !instance) {
    return (
      <SafeAreaView style={s.safe}>
        <Servers
          key={`${servers?.initialUrl ?? ""}|${servers?.notice ?? ""}`}
          saved={saved}
          selectedKey={instance?.key ?? null}
          initialUrl={servers?.initialUrl ?? null}
          notice={servers?.notice ?? null}
          onCheck={probe}
          onConfirm={confirmInstance}
          onSelect={(key) => void selectInstance(key)}
          onRemove={removeInstance}
          {...(instance ? { onClose: () => setServers(null) } : {})}
        />
      </SafeAreaView>
    );
  }
  if (!ready) return <SafeAreaView style={s.safe} />;
  if (!me || !client || !drafts) {
    return (
      <SafeAreaView style={s.safe}>
        <SignIn
          session={session}
          server={instance.baseUrl}
          state={sessionState}
          onChangeServer={() => setServers({})}
        />
      </SafeAreaView>
    );
  }
  const mailboxId = me.mailboxIds[0];
  const calendarId = me.calendarIds[0];
  if (!mailboxId) return <Text style={[s.pad, s.text]}>This account has no mailbox.</Text>;

  const body = (() => {
    switch (route.screen) {
      case "mail":
        return (
          <MailList
            client={client}
            mailboxId={mailboxId}
            view={route.view}
            refreshKey={refreshKey}
            onView={(view) => setRoute({ screen: "mail", view })}
            onOpen={(threadId) => setRoute({ screen: "thread", threadId })}
            header={
              route.view === "imbox" && calendarId ? (
                <CoverPanel
                  client={client}
                  mailboxId={mailboxId}
                  calendarId={calendarId}
                  refreshKey={refreshKey}
                  onOpenCalendar={() => setRoute({ screen: "calendar" })}
                />
              ) : null
            }
          />
        );
      case "thread":
        return (
          <Thread
            client={client}
            mailboxId={mailboxId}
            {...(calendarId ? { calendarId } : {})}
            threadId={route.threadId}
            onReply={() => setRoute({ screen: "compose", threadId: route.threadId })}
            onDone={() => setRoute(DEFAULT_ROUTE)}
          />
        );
      case "compose":
        return (
          <Composer
            key={JSON.stringify(route)}
            client={client}
            mailboxId={mailboxId}
            drafts={drafts}
            seed={route}
            onDone={() => setRoute(DEFAULT_ROUTE)}
          />
        );
      case "calendar":
        return calendarId ? (
          <View style={{ flex: 1 }}>
            <Calendar client={client} calendarId={calendarId} />
            <View style={s.pad}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setRoute({ screen: "event", date: ymd(toLocalDate(new Date())) })}
              >
                <Text style={s.text}>+ New event</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Text style={s.pad}>No calendar.</Text>
        );
      case "event":
        return calendarId ? (
          <EventEditor
            client={client}
            calendarId={calendarId}
            targetCalendarId={calendarId}
            date={route.date}
            onDone={() => setRoute({ screen: "calendar" })}
          />
        ) : (
          <Text style={s.pad}>No calendar.</Text>
        );
      case "planning":
        return calendarId ? (
          <Planning
            client={client}
            calendarId={calendarId}
            onTimer={() => setRefreshKey((k) => k + 1)}
          />
        ) : (
          <Text style={s.pad}>No calendar.</Text>
        );
      case "settings":
        return (
          <Settings
            client={client}
            mailboxId={mailboxId}
            server={instance.baseUrl}
            onSignOut={() => void signOut()}
            onManageServers={() => setServers({})}
            {...(instance.routes.accountDeletionWeb && platform.openUrl
              ? {
                  onDeleteAccount: () =>
                    void platform.openUrl?.(instance.routes.accountDeletionWeb!),
                }
              : {})}
          />
        );
      case "search":
        return (
          <Search
            client={client}
            mailboxId={mailboxId}
            initial={route.q}
            onOpen={(threadId) => setRoute({ screen: "thread", threadId })}
          />
        );
    }
  })();

  return (
    <SafeAreaView style={s.safe} key={scope}>
      <View style={[s.pad, { paddingVertical: 4 }]}>
        <Text style={s.muted} accessibilityLabel={`Server ${instance.baseUrl}`}>
          {hostOf(instance.baseUrl)}
        </Text>
      </View>
      {session && (sessionState._tag === "NotPersisted" || sessionState._tag === "Offline") ? (
        <View style={s.pad} accessibilityLiveRegion="polite">
          <Text style={s.muted}>{describeSession(sessionState)}</Text>
          {sessionState._tag === "NotPersisted" ? (
            <Pressable accessibilityRole="button" onPress={() => void session.retryPersist()}>
              <Text style={s.text}>Try saving again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={{ flex: 1 }}>{body}</View>
      <View
        style={[s.tabs, { borderTopWidth: 1, borderTopColor: colors.line }]}
        accessibilityRole="tablist"
      >
        {NAV.map(([label, target]) => (
          <Pressable
            key={label}
            accessibilityRole="tab"
            accessibilityState={{ selected: route.screen === target.screen }}
            style={[s.tab, route.screen === target.screen && s.tabActive]}
            onPress={() => setRoute(target)}
          >
            <Text style={s.text}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
};

/** The app root every shell renders: global error hook plus a boundary around the whole tree. */
export const ByeApp = ({ platform }: { platform: Platform }) => {
  useEffect(installNativeErrorHandler, []);
  // Dark status bar text on Paper (mobile only; desktop has no status bar). Android draws
  // edge-to-edge, so the status bar is transparent over the Paper background.
  useEffect(() => {
    if (RNPlatform.OS === "ios" || RNPlatform.OS === "android")
      StatusBar.setBarStyle("dark-content");
  }, []);
  return (
    <ErrorBoundary>
      <ByeAppRoot platform={platform} />
    </ErrorBoundary>
  );
};
