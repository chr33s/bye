import React, { useState } from "react";
import { ScrollView, Switch, Text, TextInput, View } from "react-native";
import { eventPayload, type EventForm, type Frequency } from "../calendar-form.ts";
import type { ByeClient } from "../client.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

const FREQUENCIES: ReadonlyArray<readonly [Frequency, string]> = [
  ["none", "Once"],
  ["DAILY", "Daily"],
  ["WEEKLY", "Weekly"],
  ["MONTHLY", "Monthly"],
  ["YEARLY", "Yearly"],
];

/** Event editor (C02/C03): wall-clock time in the device zone, recurrence, attendees, reminders. */
export const EventEditor = ({
  client,
  calendarId,
  targetCalendarId,
  date,
  onDone,
}: {
  client: ByeClient;
  calendarId: string;
  targetCalendarId: string;
  date: string;
  onDone: () => void;
}) => {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [form, setForm] = useState<EventForm>({
    calendarId: targetCalendarId,
    title: "",
    allDay: false,
    start: `${date}T09:00`,
    end: `${date}T10:00`,
    timeZone: tz,
    frequency: "none",
    interval: 1,
    byDay: [],
    ends: { kind: "never" },
    location: "",
    description: "",
    attendees: "",
    reminders: "10",
  });
  const [errors, setErrors] = useState<ReadonlyArray<string>>([]);
  const [saving, setSaving] = useState(false);
  const set =
    <K extends keyof EventForm>(key: K) =>
    (value: EventForm[K]) =>
      setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    const built = eventPayload(form);
    if (!built.ok) {
      setErrors(built.errors.map((e) => `${e.field}: ${e.message}`));
      return;
    }
    setSaving(true);
    try {
      await client.calendarCommand(calendarId, built.command);
      onDone();
    } catch (e) {
      setErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setSaving(false);
    }
  };

  const field = (
    label: string,
    key: "title" | "start" | "end" | "location" | "attendees" | "reminders" | "description",
    placeholder?: string,
  ) => (
    <View style={{ marginBottom: 8 }}>
      <Text style={s.muted}>{label}</Text>
      <TextInput
        style={s.input}
        accessibilityLabel={label}
        placeholder={placeholder}
        value={form[key]}
        onChangeText={set(key)}
        multiline={key === "description"}
      />
    </View>
  );

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1} accessibilityRole="header">
        New event
      </Text>
      {errors.length ? (
        <View accessibilityLiveRegion="assertive">
          {errors.map((e) => (
            <Text key={e} style={s.error}>
              {e}
            </Text>
          ))}
        </View>
      ) : null}
      {field("Title", "title")}
      <View style={[s.row, { paddingHorizontal: 0 }]}>
        <Text style={[s.text, { flex: 1 }]}>All day</Text>
        <Switch
          accessibilityLabel="All day"
          value={form.allDay}
          onValueChange={(v) =>
            setForm((f) => ({
              ...f,
              allDay: v,
              start: v ? f.start.slice(0, 10) : `${f.start.slice(0, 10)}T09:00`,
              end: v ? f.end.slice(0, 10) : `${f.end.slice(0, 10)}T10:00`,
            }))
          }
        />
      </View>
      {field(form.allDay ? "Starts (YYYY-MM-DD)" : "Starts (YYYY-MM-DDTHH:mm)", "start")}
      {field(form.allDay ? "Ends (YYYY-MM-DD)" : "Ends (YYYY-MM-DDTHH:mm)", "end")}
      <Text style={s.muted}>{`Time zone: ${tz}`}</Text>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginVertical: 8 }}
        accessibilityLabel="Repeat"
      >
        {FREQUENCIES.map(([f, label]) => (
          <Button
            key={f}
            label={label}
            primary={form.frequency === f}
            onPress={() => set("frequency")(f)}
          />
        ))}
      </View>
      {field("Location", "location")}
      {field("Invite (addresses)", "attendees", "a@example.com, b@example.com")}
      {field("Reminders (minutes before)", "reminders", "10, 60")}
      {field("Notes", "description")}
      <Button
        label={saving ? "Saving…" : "Save"}
        primary
        disabled={saving}
        onPress={() => void save()}
      />
    </ScrollView>
  );
};
