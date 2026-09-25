import React, { useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import type { ByeClient } from "../client.ts";
import type { MailSearchResponse } from "@bye/contracts";
import { s } from "./theme.ts";

export const Search = ({
  client,
  mailboxId,
  initial,
  onOpen,
}: {
  client: ByeClient;
  mailboxId: string;
  initial: string;
  onOpen: (threadId: string) => void;
}) => {
  const [q, setQ] = useState(initial);
  const [result, setResult] = useState<typeof MailSearchResponse.Type | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    if (!q.trim()) return;
    client.search(mailboxId, q).then(setResult, (e: unknown) => setError(String(e)));
  };
  return (
    <View style={s.screen}>
      <View style={s.pad}>
        <TextInput
          style={s.input}
          value={q}
          onChangeText={setQ}
          onSubmitEditing={run}
          returnKeyType="search"
          autoCapitalize="none"
          placeholder='from:a@b.com "phrase" -exclude in:trash'
          accessibilityLabel="Search"
        />
        {result?.lagging ? (
          <Text style={s.muted}>Search is catching up; recent mail may be missing.</Text>
        ) : null}
        {error ? <Text style={s.error}>{error}</Text> : null}
      </View>
      <FlatList
        data={result?.results ?? []}
        keyExtractor={(r) => `${r.kind}:${r.id}`}
        ListEmptyComponent={result ? <Text style={[s.muted, s.pad]}>No results.</Text> : null}
        renderItem={({ item }) => (
          <Pressable
            style={s.row}
            accessibilityRole="button"
            disabled={!item.threadId}
            onPress={() => item.threadId && onOpen(item.threadId)}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.muted}>
                {item.kind} · {new Date(item.date).toLocaleDateString()}
              </Text>
              <Text style={s.text} numberOfLines={2}>
                {item.snippet}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </View>
  );
};
