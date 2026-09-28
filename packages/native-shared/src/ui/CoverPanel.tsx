import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { OccurrenceWire } from "@bye/contracts";
import type { ByeClient } from "../client.ts";
import {
  calendarPanelEnabled,
  type CoverAgenda,
  coverAgenda,
  coverTimeText,
  coverWindow,
} from "../mail-calendar.ts";
import { Button } from "./Button.tsx";
import { colors, s } from "./theme.ts";

type Load =
  | { readonly _tag: "Off" }
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Ready"; readonly at: number; readonly agenda: CoverAgenda<OccurrenceWire> };

/**
 * Calendar cover panel (C09) at the top of the Imbox: today's agenda and the next event, with a
 * way into the calendar. It shows only while the `calendarPanel` mailbox preference is on (Settings
 * turns it on; "Hide" turns it off everywhere). Collapsing is for this screen only.
 */
export const CoverPanel = ({
  client,
  mailboxId,
  calendarId,
  refreshKey,
  onOpenCalendar,
}: {
  client: ByeClient;
  mailboxId: string;
  calendarId: string;
  refreshKey: number;
  onOpenCalendar: () => void;
}) => {
  const [state, setState] = useState<Load>({ _tag: "Off" });
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      const enabled = await client.preferences(mailboxId).then(calendarPanelEnabled, () => false);
      if (!live) return;
      if (!enabled) return setState({ _tag: "Off" });
      setState({ _tag: "Loading" });
      const at = Date.now();
      const { from, to } = coverWindow(at);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      try {
        const r = await client.occurrences(calendarId, from, to, tz);
        if (live) setState({ _tag: "Ready", at, agenda: coverAgenda(r.occurrences, at) });
      } catch (e) {
        if (live) setState({ _tag: "Failed", message: e instanceof Error ? e.message : String(e) });
      }
    })();
    return () => {
      live = false;
    };
  }, [client, mailboxId, calendarId, refreshKey, attempt]);

  const hide = useCallback(() => {
    setStatus("Hiding…");
    void client.setPreference(mailboxId, "calendarPanel", false).then(
      () => setState({ _tag: "Off" }),
      (e: unknown) => setStatus(`Couldn't hide: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [client, mailboxId]);

  if (state._tag === "Off") return null;
  return (
    <View
      style={{
        margin: 16,
        marginBottom: 0,
        padding: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.line,
        backgroundColor: colors.surface,
      }}
      accessibilityLabel="Today's calendar"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Today's calendar"
        accessibilityHint={expanded ? "Collapses the calendar panel" : "Expands the calendar panel"}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((v) => !v)}
      >
        <Text style={s.h2} accessibilityRole="header">
          {`${expanded ? "▾" : "▸"} Today's calendar`}
        </Text>
      </Pressable>
      {expanded ? (
        <View>
          {state._tag === "Loading" ? (
            <ActivityIndicator accessibilityLabel="Loading your calendar" style={{ margin: 12 }} />
          ) : state._tag === "Failed" ? (
            <View>
              <Text style={s.error} accessibilityRole="alert">
                {`Calendar unavailable: ${state.message}`}
              </Text>
              <Button label="Try again" onPress={() => setAttempt((n) => n + 1)} />
            </View>
          ) : (
            <View>
              {state.agenda.today.length === 0 ? (
                <Text style={s.muted}>Nothing on your calendar today.</Text>
              ) : (
                state.agenda.today.map((o) => (
                  <Text
                    key={`${o.eventId}:${o.key}`}
                    style={s.text}
                    accessibilityLabel={`${o.data.summary}, ${coverTimeText(o, state.at)}`}
                  >
                    <Text style={s.muted}>{`${coverTimeText(o, state.at)}  `}</Text>
                    {o.data.summary || "(untitled)"}
                  </Text>
                ))
              )}
              <Text style={[s.muted, { marginTop: 8 }]}>
                {state.agenda.next
                  ? `Next: ${state.agenda.next.data.summary || "(untitled)"} · ${coverTimeText(state.agenda.next, state.at)}`
                  : "Nothing else coming up this week."}
              </Text>
            </View>
          )}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            <Button label="Open calendar" onPress={onOpenCalendar} />
            <Button label="Hide panel" hint="Turn it back on in Settings" onPress={hide} />
          </View>
          {status ? (
            <Text style={s.muted} accessibilityLiveRegion="polite">
              {status}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
};
