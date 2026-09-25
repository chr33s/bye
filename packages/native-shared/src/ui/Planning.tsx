import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { addDays, toLocalDate, weekStart, ymd } from "../calendar-form.ts";
import type { ByeClient } from "../client.ts";
import type { CalendarCommandInput } from "../client.ts";
import type { HabitWire, TimerWire, WeekTaskWire } from "../wire.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

/** Sometime-this-week tasks (C06), habits and the single active timer (C07). */
export const Planning = ({
  client,
  calendarId,
  onTimer,
}: {
  client: ByeClient;
  calendarId: string;
  onTimer?: (timer: { label: string; startedAtMs: number } | null) => void;
}) => {
  const today = toLocalDate(new Date());
  const monday = weekStart(today, 1);
  const [tasks, setTasks] = useState<ReadonlyArray<WeekTaskWire> | null>(null);
  const [habits, setHabits] = useState<ReadonlyArray<HabitWire>>([]);
  const [timer, setTimer] = useState<TimerWire | null>(null);
  const [title, setTitle] = useState("");
  const [habit, setHabit] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, h, tm] = await Promise.all([
        client.weekTasks(calendarId, ymd(today)),
        client.habits(calendarId, ymd(addDays(today, -6)), ymd(today)),
        client.timer(calendarId),
      ]);
      setTasks(t.items);
      setHabits(h.items);
      setTimer(tm);
      onTimer?.(tm?.active ? { label: tm.active.label, startedAtMs: tm.active.startedAt } : null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, calendarId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = (command: CalendarCommandInput) => () =>
    void client
      .calendarCommand(calendarId, command)
      .then(load, (e: unknown) => setError(String(e)));
  const id = (x: { id?: string; taskId?: string; habitId?: string }) =>
    x.taskId ?? x.habitId ?? x.id ?? "";

  if (tasks === null)
    return error ? (
      <Text style={[s.error, s.pad]}>{error}</Text>
    ) : (
      <ActivityIndicator style={{ margin: 32 }} />
    );
  const active = timer?.active ?? null;
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      {error ? <Text style={s.error}>{error}</Text> : null}
      <Text style={s.h2} accessibilityRole="header">{`Sometime this week`}</Text>
      {tasks.map((t) => (
        <View key={id(t)} style={s.row}>
          <Switch
            accessibilityLabel={`Done: ${t.title}`}
            value={Boolean(t.completed ?? t.completedAt)}
            onValueChange={(v) => run({ type: "CompleteWeekTask", taskId: id(t), completed: v })()}
          />
          <Text style={[s.text, { flex: 1, marginLeft: 8 }]}>{t.title}</Text>
          <Button
            label="Next week"
            onPress={run({
              type: "MoveWeekTask",
              taskId: id(t),
              date: addDays(monday, 7),
              firstWeekday: 1,
            })}
          />
        </View>
      ))}
      <View style={{ flexDirection: "row", gap: 8, marginVertical: 8 }}>
        <TextInput
          style={[s.input, { flex: 1 }]}
          accessibilityLabel="New task this week"
          placeholder="Something for this week"
          value={title}
          onChangeText={setTitle}
        />
        <Button
          label="Add"
          onPress={() => {
            if (title.trim())
              run({ type: "AddWeekTask", date: today, firstWeekday: 1, title: title.trim() })();
            setTitle("");
          }}
        />
      </View>

      <Text style={s.h2} accessibilityRole="header">
        Habits today
      </Text>
      {habits.map((h) => {
        const done = (h.completed ?? []).includes(ymd(today));
        return (
          <View key={id(h)} style={s.row}>
            <Switch
              accessibilityLabel={`${h.name} today`}
              value={done}
              onValueChange={(v) =>
                run({ type: "SetHabitCompletion", habitId: id(h), date: today, completed: v })()
              }
            />
            <Text
              style={[s.text, { flex: 1, marginLeft: 8 }]}
            >{`${h.name} · ${(h.completed ?? []).length}/7 this week`}</Text>
          </View>
        );
      })}
      <View style={{ flexDirection: "row", gap: 8, marginVertical: 8 }}>
        <TextInput
          style={[s.input, { flex: 1 }]}
          accessibilityLabel="New habit"
          value={habit}
          onChangeText={setHabit}
        />
        <Button
          label="Add habit"
          onPress={() => {
            if (habit.trim())
              run({ type: "CreateHabit", name: habit.trim(), weekdays: [0, 1, 2, 3, 4, 5, 6] })();
            setHabit("");
          }}
        />
      </View>

      <Text style={s.h2} accessibilityRole="header">
        Timer
      </Text>
      {active ? (
        <View style={s.row}>
          <Text
            style={[s.text, { flex: 1 }]}
          >{`${active.label} · since ${new Date(active.startedAt).toLocaleTimeString()}`}</Text>
          <Button label="Stop" primary onPress={run({ type: "StopTimer" })} />
        </View>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <TextInput
            style={[s.input, { flex: 1 }]}
            accessibilityLabel="What are you working on?"
            value={label}
            onChangeText={setLabel}
          />
          <Button
            label="Start"
            primary
            onPress={run({ type: "StartTimer", label: label.trim() || "Focus" })}
          />
        </View>
      )}
    </ScrollView>
  );
};
