import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from "react-native";
import { type JmapClient } from "../jmap.ts";
import type { JsonObject, JsonValue } from "../json.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

// Mail for accounts served by the JMAP core (spec.md §16 C4) on mobile and desktop: Mailboxes,
// Emails and native actions through the standard API. Bodies are plain-text body values; nothing
// a sender wrote is rendered as markup.

const objectOf = (value: JsonValue | undefined): JsonObject | null =>
  value !== null &&
  value !== undefined &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype
    ? (value as JsonObject)
    : null;

const listOf = (value: JsonValue | undefined): ReadonlyArray<JsonObject> =>
  Array.isArray(value)
    ? (value as ReadonlyArray<JsonValue>).flatMap((v) => {
        const o = objectOf(v);

        return o ? [o] : [];
      })
    : [];

const str = (value: JsonValue | undefined): string =>
  value === undefined || value === null ? "" : String(value);

const addressLine = (value: JsonValue | undefined): string =>
  listOf(value)
    .map((a) => (str(a["name"]) ? `${str(a["name"])} <${str(a["email"])}>` : str(a["email"])))
    .join(", ");

const results = async (jmap: JmapClient, calls: Parameters<JmapClient["call"]>[0]) => {
  const out = await jmap.call(calls);
  const map = new Map<string, JsonObject>();

  for (const [id, [name, args]] of out) {
    if (name === "error")
      throw new Error(`${str(args["type"])} ${str(args["description"])}`.trim());
    map.set(id, args);
  }

  return map;
};

interface ListProps {
  readonly jmap: JmapClient;
  readonly accountId: string;
  readonly onOpen: (emailId: string) => void;
  readonly refreshKey: number;
}

export const JmapMailList = ({ jmap, accountId, onOpen, refreshKey }: ListProps) => {
  const [mailboxes, setMailboxes] = useState<ReadonlyArray<JsonObject>>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [emails, setEmails] = useState<ReadonlyArray<JsonObject>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);

    try {
      const boxes = listOf(
        (await results(jmap, [["Mailbox/get", { accountId, ids: null }, "m"]])).get("m")?.["list"],
      );
      const target = current ?? str(boxes.find((b) => b["role"] === "inbox")?.["id"]);
      setMailboxes(boxes);
      setCurrent(target);

      const r = await results(jmap, [
        [
          "Email/query",
          {
            accountId,
            filter: { inMailbox: target },
            sort: [{ property: "receivedAt", isAscending: false }],
            limit: 100,
          },
          "q",
        ],
        [
          "Email/get",
          {
            accountId,
            "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
            properties: ["subject", "from", "receivedAt", "keywords", "preview"],
          },
          "g",
        ],
      ]);

      setEmails(listOf(r.get("g")?.["list"]));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [jmap, accountId, current]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  return (
    <View style={s.screen}>
      <View style={s.tabs} accessibilityRole="tablist">
        {mailboxes.slice(0, 6).map((m) => (
          <Pressable
            key={str(m["id"])}
            accessibilityRole="tab"
            accessibilityState={{ selected: m["id"] === current }}
            style={[s.tab, m["id"] === current && s.tabActive]}
            onPress={() => setCurrent(str(m["id"]))}
          >
            <Text style={s.muted}>{str(m["name"])}</Text>
          </Pressable>
        ))}
      </View>
      {error ? <Text style={[s.error, s.pad]}>{error}</Text> : null}
      <FlatList
        data={emails}
        keyExtractor={(e) => str(e["id"])}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator style={{ margin: 32 }} />
          ) : (
            <Text style={[s.muted, s.pad]}>Nothing here.</Text>
          )
        }
        renderItem={({ item }) => {
          const unread = objectOf(item["keywords"])?.["$seen"] !== true;

          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${unread ? "Unread, " : ""}${addressLine(item["from"])}: ${str(item["subject"])}`}
              style={[s.row, unread && s.rowUnseen]}
              onPress={() => onOpen(str(item["id"]))}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.sender}>{addressLine(item["from"]) || "(unknown sender)"}</Text>
                <Text style={s.text}>{str(item["subject"]) || "(no subject)"}</Text>
                <Text style={s.muted} numberOfLines={1}>
                  {str(item["preview"])}
                </Text>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
};

interface EmailProps {
  readonly jmap: JmapClient;
  readonly accountId: string;
  readonly emailId: string;
  readonly onDone: () => void;
}

export const JmapEmail = ({ jmap, accountId, emailId, onDone }: EmailProps) => {
  const [email, setEmail] = useState<JsonObject | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback(
    async (action: JsonObject) => {
      const r = await results(jmap, [
        [
          "EmailAction/apply",
          {
            accountId,
            emails: { [emailId]: null },
            action,
            intentId: `${emailId}:${JSON.stringify(action)}:${Date.now()}`,
          },
          "a",
        ],
      ]);

      return objectOf(objectOf(r.get("a")?.["results"])?.[emailId])?.["ok"] === true;
    },
    [jmap, accountId, emailId],
  );

  useEffect(() => {
    void (async () => {
      try {
        const r = await results(jmap, [
          [
            "Email/get",
            {
              accountId,
              ids: [emailId],
              properties: [
                "subject",
                "from",
                "to",
                "receivedAt",
                "keywords",
                "textBody",
                "bodyValues",
                "attachments",
              ],
              fetchTextBodyValues: true,
            },
            "g",
          ],
        ]);
        const e = listOf(r.get("g")?.["list"])[0] ?? null;
        setEmail(e);

        if (e && objectOf(e["keywords"])?.["$seen"] !== true)
          void apply({ type: "seen", value: true }).catch(() => undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [jmap, accountId, emailId, apply]);

  if (error) return <Text style={[s.error, s.pad]}>{error}</Text>;

  if (!email) return <ActivityIndicator style={{ margin: 32 }} />;
  const values = objectOf(email["bodyValues"]) ?? {};
  const body = listOf(email["textBody"])
    .map((p) => str(objectOf(values[str(p["partId"])])?.["value"]))
    .join("\n\n");

  const act = (action: JsonObject) => () =>
    void apply(action).then((ok) =>
      ok ? onDone() : setError("That didn't work; the message may have changed."),
    );

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h2} accessibilityRole="header">
        {str(email["subject"]) || "(no subject)"}
      </Text>
      <Text style={s.muted}>From {addressLine(email["from"])}</Text>
      <Text style={s.muted}>To {addressLine(email["to"])}</Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginVertical: 12 }}>
        <Button label="Archive" onPress={act({ type: "archive" })} />
        <Button label="Trash" onPress={act({ type: "trash" })} />
        <Button label="Mark unread" onPress={act({ type: "seen", value: false })} />
      </View>
      <Text style={s.text} selectable>
        {body}
      </Text>
      {listOf(email["attachments"]).map((a) => (
        <Text key={str(a["blobId"])} style={s.muted}>
          📎 {str(a["name"]) || "attachment"}
        </Text>
      ))}
    </ScrollView>
  );
};
