import React, { useEffect, useState } from "react";
import { ActivityIndicator, SectionList, Text, View } from "react-native";
import { type ByeClient, weekStart } from "../client.ts";
import type { OccurrenceWire } from "@bye/contracts";
import { Button } from "./Button.tsx";
import type { WidgetSnapshot } from "./platform.ts";
import { s } from "./theme.ts";

const DAY = 86_400_000;

/** Week agenda (C01) over the calendar occurrences API, with week navigation. */
export const Calendar = ({
  client,
  calendarId,
  onSnapshot,
}: {
  client: ByeClient;
  calendarId: string;
  onSnapshot?: (s: WidgetSnapshot["nextEvent"]) => void;
}) => {
  const [start, setStart] = useState(() => weekStart(new Date()).getTime());
  const [items, setItems] = useState<ReadonlyArray<OccurrenceWire> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    setItems(null);
    client
      .occurrences(calendarId, start, start + 7 * DAY, tz)
      .then((r) => {
        setItems(r.occurrences);
        const next = r.occurrences
          .filter((o) => o.startMs > Date.now())
          .sort((a, b) => a.startMs - b.startMs)[0];
        onSnapshot?.(next ? { title: next.data.summary, startMs: next.startMs } : null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [client, calendarId, start, tz, onSnapshot]);

  const sections = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(start + i * DAY);
    return {
      title: day.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }),
      data: (items ?? []).filter((o) => new Date(o.startMs).toDateString() === day.toDateString()),
    };
  });

  return (
    <View style={s.screen}>
      <View style={{ flexDirection: "row", gap: 8, padding: 16 }}>
        <Button label="Previous week" onPress={() => setStart((v) => v - 7 * DAY)} />
        <Button label="This week" onPress={() => setStart(weekStart(new Date()).getTime())} />
        <Button label="Next week" onPress={() => setStart((v) => v + 7 * DAY)} />
      </View>
      {error ? <Text style={[s.error, s.pad]}>{error}</Text> : null}
      {items === null ? (
        <ActivityIndicator style={{ margin: 32 }} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(o) => `${o.eventId}:${o.key}`}
          renderSectionHeader={({ section }) => (
            <Text style={[s.h2, { paddingHorizontal: 16 }]}>{section.title}</Text>
          )}
          renderSectionFooter={({ section }) =>
            section.data.length === 0 ? (
              <Text style={[s.muted, { paddingHorizontal: 16 }]}>Free</Text>
            ) : null
          }
          renderItem={({ item }) => (
            <View
              style={s.row}
              accessibilityLabel={`${item.data.summary}, ${item.allDay ? "all day" : new Date(item.startMs).toLocaleTimeString()}`}
            >
              <Text style={[s.muted, { width: 72 }]}>
                {item.allDay
                  ? "All day"
                  : new Date(item.startMs).toLocaleTimeString(undefined, {
                      hour: "numeric",
                      minute: "2-digit",
                    })}
              </Text>
              <Text style={s.text}>{item.data.summary}</Text>
            </View>
          )}
        />
      )}
    </View>
  );
};
