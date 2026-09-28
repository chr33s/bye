import React, { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { AFTER_SEND_CHOICES, type AfterSendChoice, afterSendFor } from "../after-send.ts";
import type { ByeClient } from "../client.ts";
import { type DraftStore, type NativeDraft, syncDraft } from "../drafts.ts";
import { describeSendJobs, sendJobsSettled } from "../send-status.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

const split = (value: string) =>
  value
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .map((address) => ({ address }));
const join = (xs: ReadonlyArray<{ address: string }>) => xs.map((x) => x.address).join(", ");

export interface ComposeSeed {
  readonly to?: string;
  readonly subject?: string;
  readonly text?: string;
  readonly threadId?: string;
}

/** Composer with local-first autosave (E17) and an honest send/undo state (E18). */
export const Composer = ({
  client,
  mailboxId,
  drafts,
  seed,
  onDone,
}: {
  client: ByeClient;
  mailboxId: string;
  drafts: DraftStore;
  seed: ComposeSeed;
  onDone: () => void;
}) => {
  const [draft, setDraft] = useState<NativeDraft>(() => ({
    localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mailboxId,
    draftId: null,
    baseRevision: 0,
    threadId: seed.threadId ?? null,
    content: {
      to: split(seed.to ?? ""),
      cc: [],
      bcc: [],
      subject: seed.subject ?? "",
      text: seed.text ?? "",
      attachments: [],
    },
    state: "local",
    updatedAt: Date.now(),
  }));
  const [status, setStatus] = useState("");
  const [afterSend, setAfterSend] = useState<AfterSendChoice>("none");
  const [jobs, setJobs] = useState<ReadonlyArray<string>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const update = (patch: Partial<NativeDraft["content"]>) =>
    setDraft((d) => ({
      ...d,
      content: { ...d.content, ...patch },
      state: d.state === "synced" ? "local" : d.state,
      updatedAt: Date.now(),
    }));

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      await drafts.save(draft);
      const synced = await syncDraft(client, draft, (id) => client.getDraft(mailboxId, id));
      if (synced !== draft) {
        setDraft(synced);
        await drafts.save(synced);
      }
      setStatus(
        synced.state === "conflict"
          ? "This draft changed on another device; both versions are kept."
          : synced.draftId
            ? "Draft saved"
            : "Saved on this device",
      );
    }, 800);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.content]);

  const send = async () => {
    const synced = await syncDraft(client, draft, (id) => client.getDraft(mailboxId, id));
    if (!synced.draftId || synced.state === "conflict") {
      const queued = { ...synced, state: "queued-send" as const };
      setDraft(queued);
      await drafts.save(queued);
      setStatus("Queued on this device — not sent yet");
      return;
    }
    try {
      const result = await client.send(
        mailboxId,
        synced.draftId,
        synced.baseRevision,
        undefined,
        afterSendFor(afterSend, Date.now()),
      );
      if (result._tag === "Conflict")
        return setStatus("This draft changed elsewhere; review before sending.");
      setJobs(result.sendJobIds);
      setStatus("Sending…");
      await drafts.remove(synced.localId);
    } catch (e) {
      setStatus(`Not sent: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // After the undo window, poll the jobs and show per-recipient outcomes (E18).
  const [outcomes, setOutcomes] = useState<ReadonlyArray<string>>([]);
  useEffect(() => {
    if (jobs.length === 0) return;
    let stopped = false;
    let tries = 0;
    const tick = async () => {
      if (stopped) return;
      try {
        const views = await Promise.all(jobs.map((id) => client.sendJob(mailboxId, id)));
        setOutcomes(describeSendJobs(views));
        if (sendJobsSettled(views) || ++tries > 40) return;
      } catch {
        if (++tries > 40) return;
      }
      setTimeout(() => void tick(), 3_000);
    };
    const first = setTimeout(() => void tick(), 3_000);
    return () => {
      stopped = true;
      clearTimeout(first);
    };
  }, [client, mailboxId, jobs]);

  const undo = async () => {
    const results = await Promise.all(jobs.map((id) => client.cancelSend(mailboxId, id)));
    setStatus(
      results.every((r) => r._tag === "Cancelled")
        ? "Send cancelled"
        : "Too late to undo — already submitted",
    );
    setJobs([]);
  };

  return (
    <ScrollView contentContainerStyle={s.pad} keyboardShouldPersistTaps="handled">
      <Text style={s.h1} accessibilityRole="header">
        {draft.threadId ? "Reply" : "New message"}
      </Text>
      <TextInput
        style={s.input}
        placeholder="To"
        accessibilityLabel="To"
        autoCapitalize="none"
        keyboardType="email-address"
        value={join(draft.content.to)}
        onChangeText={(v) => update({ to: split(v) })}
      />
      <TextInput
        style={s.input}
        placeholder="Subject"
        accessibilityLabel="Subject"
        value={draft.content.subject}
        onChangeText={(v) => update({ subject: v })}
      />
      <TextInput
        style={[s.input, { minHeight: 200, textAlignVertical: "top" }]}
        multiline
        accessibilityLabel="Message"
        value={draft.content.text}
        onChangeText={(v) => update({ text: v })}
      />
      <Text style={s.muted} nativeID="after-send-label">
        After sending
      </Text>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 }}
        accessibilityRole="radiogroup"
        accessibilityLabel="After sending"
      >
        {AFTER_SEND_CHOICES.filter((c) => draft.threadId || !c.replyOnly).map((c) => (
          <Button
            key={c.value}
            label={c.label}
            selected={afterSend === c.value}
            onPress={() => setAfterSend(c.value)}
          />
        ))}
      </View>
      {jobs.length ? (
        <Button label="Undo send" onPress={undo} />
      ) : (
        <Button label="Send" primary onPress={send} />
      )}
      <Button label="Close" onPress={onDone} />
      <Text style={s.muted} accessibilityLiveRegion="polite">
        {status}
      </Text>
      {outcomes.map((line, i) => (
        <Text key={i} style={s.muted}>
          {line}
        </Text>
      ))}
    </ScrollView>
  );
};
