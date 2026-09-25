import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, Text, View } from "react-native";
import type { ByeClient } from "../client.ts";
import { MAIL_VIEW_NAV, type MailView } from "../views.ts";
import type { MailThreadSummaryWire } from "../wire.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

export const VIEW_TABS: ReadonlyArray<readonly [MailView, string]> = MAIL_VIEW_NAV.map(
  (n) => [n.view, n.short] as const,
);

interface Props {
  readonly client: ByeClient;
  readonly mailboxId: string;
  readonly view: MailView;
  readonly onView: (view: MailView) => void;
  readonly onOpen: (threadId: string) => void;
  readonly refreshKey: number;
}

export const MailList = ({ client, mailboxId, view, onView, onOpen, refreshKey }: Props) => {
  const [items, setItems] = useState<ReadonlyArray<MailThreadSummaryWire>>([]);
  const [boundary, setBoundary] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await client.view(mailboxId, view);
      setItems(page.items);
      setBoundary(page.boundary);
      setCursor(page.nextCursor);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [client, mailboxId, view]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // Cursor paging (§8): later pages append; a thread already shown is replaced, never duplicated.
  const loadMore = useCallback(async () => {
    if (!cursor || more) return;
    setMore(true);
    try {
      const page = await client.view(mailboxId, view, cursor);
      setItems((current) => {
        const byId = new Map(current.map((t, i) => [t.threadId, i] as const));
        const next = [...current];
        for (const t of page.items) {
          const at = byId.get(t.threadId);
          if (at === undefined) next.push(t);
          else next[at] = t;
        }
        return next;
      });
      setCursor(page.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setMore(false);
    }
  }, [client, mailboxId, view, cursor, more]);

  const act = (fn: () => Promise<unknown>) => () =>
    void fn().then(load, (e: unknown) => setError(String(e)));

  // Imbox separates New For You from Previously Seen (E04).
  const fresh = view === "imbox" ? items.filter((t) => t.newForYou) : items;
  const seen = view === "imbox" ? items.filter((t) => !t.newForYou) : [];
  const data: Array<
    { kind: "header"; label: string } | { kind: "thread"; thread: MailThreadSummaryWire }
  > = [
    ...(view === "imbox" && fresh.length
      ? [{ kind: "header" as const, label: "New for you" }]
      : []),
    ...fresh.map((thread) => ({ kind: "thread" as const, thread })),
    ...(seen.length ? [{ kind: "header" as const, label: "Previously seen" }] : []),
    ...seen.map((thread) => ({ kind: "thread" as const, thread })),
  ];

  return (
    <View style={s.screen}>
      <View style={s.tabs} accessibilityRole="tablist">
        {VIEW_TABS.map(([id, label]) => (
          <Pressable
            key={id}
            accessibilityRole="tab"
            accessibilityState={{ selected: id === view }}
            style={[s.tab, id === view && s.tabActive]}
            onPress={() => onView(id)}
          >
            <Text style={s.muted}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={[s.error, s.pad]}>{error}</Text> : null}
      {view === "screener" && items.length > 0 ? (
        <View style={[s.pad, { paddingBottom: 0, flexDirection: "row", gap: 8, flexWrap: "wrap" }]}>
          <Button
            label="Approve all"
            onPress={act(() =>
              client.screenMany(
                mailboxId,
                items.map((t) => t.sender),
                true,
              ),
            )}
          />
          <Button
            label="Approve all into Feed"
            onPress={act(() =>
              client.screenMany(
                mailboxId,
                items.map((t) => t.sender),
                true,
                { destination: "feed" },
              ),
            )}
          />
          <Button
            label="Screen out all"
            onPress={act(() =>
              client.screenMany(
                mailboxId,
                items.map((t) => t.sender),
                false,
              ),
            )}
          />
          <Button
            label="Clear (decide later)"
            onPress={act(() => client.clearScreener(mailboxId, boundary))}
          />
        </View>
      ) : null}
      {view === "imbox" && fresh.length > 0 ? (
        <View style={[s.pad, { paddingBottom: 0 }]}>
          <Button
            label="Mark all seen"
            onPress={act(() => client.command(mailboxId, { _tag: "MarkAllSeen", view, boundary }))}
          />
        </View>
      ) : null}
      <FlatList
        data={data}
        keyExtractor={(item, i) => (item.kind === "thread" ? item.thread.threadId : `h${i}`)}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        onEndReachedThreshold={0.5}
        onEndReached={() => void loadMore()}
        ListFooterComponent={
          more ? (
            <ActivityIndicator style={{ margin: 16 }} />
          ) : cursor ? (
            <View style={s.pad}>
              <Button label="Load more" onPress={() => void loadMore()} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ margin: 32 }} />
          ) : (
            <Text style={[s.muted, s.pad]}>
              {view === "screener" ? "Nobody is waiting to be screened." : "Nothing here."}
            </Text>
          )
        }
        renderItem={({ item }) =>
          item.kind === "header" ? (
            <Text style={[s.h2, { paddingHorizontal: 16 }]} accessibilityRole="header">
              {item.label}
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.thread.sender}: ${item.thread.subject}`}
              onPress={() => onOpen(item.thread.threadId)}
              style={[s.row, item.thread.newForYou && s.rowUnseen]}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.text} numberOfLines={1}>
                  {item.thread.bundleCount > 1
                    ? `${item.thread.sender} (${item.thread.bundleCount})`
                    : item.thread.sender}
                </Text>
                <Text style={s.muted} numberOfLines={1}>
                  {item.thread.subject || "(no subject)"}
                </Text>
              </View>
              {view === "spam" || view === "trash" || view === "screened-out" ? (
                <Button
                  label="Restore"
                  onPress={act(() => client.restore(mailboxId, [item.thread.threadId]))}
                />
              ) : null}
              {view === "screener" ? (
                <View style={{ flexDirection: "row", gap: 8 }}>
                  <Button
                    label="Yes"
                    onPress={act(() => client.screen(mailboxId, item.thread.sender, true))}
                  />
                  <Button
                    label="No"
                    onPress={act(() => client.screen(mailboxId, item.thread.sender, false))}
                  />
                </View>
              ) : null}
            </Pressable>
          )
        }
      />
    </View>
  );
};
