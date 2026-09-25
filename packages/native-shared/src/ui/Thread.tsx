import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, ScrollView, Text, View } from "react-native";
import { WebView } from "react-native-webview";
import type { ByeClient } from "../client.ts";
import type { DeliveryWire, ThreadDetailWire } from "../wire.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

const SCAN_NOTICE: Readonly<Record<string, string>> = {
  pending: "Scanning attachments…",
  infected: "Attachments blocked: a threat was detected.",
  failed: "Attachments blocked: they couldn't be scanned.",
};

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Thread view. Message HTML is never rendered natively or with app credentials: each message is a
 * sandboxed WebView pointed at its short-lived render URL on the separate MAIL_ORIGIN (§10), with
 * JavaScript, storage and cookies off. Any navigation away opens in the system browser.
 */
export const Thread = ({
  client,
  mailboxId,
  threadId,
  onReply,
  onDone,
}: {
  client: ByeClient;
  mailboxId: string;
  threadId: string;
  onReply: () => void;
  onDone?: () => void;
}) => {
  const [detail, setDetail] = useState<ThreadDetailWire | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    client
      .thread(mailboxId, threadId)
      .then(async (d) => {
        if (!live) return;
        setDetail(d);
        await client.markSeen(mailboxId, threadId, d.thread.revision);
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [client, mailboxId, threadId]);

  const act = useCallback(
    (label: string, fn: () => Promise<unknown>, leave = false) =>
      () => {
        setStatus(`${label}…`);
        void fn().then(
          () => {
            setStatus(label);
            if (leave) onDone?.();
          },
          (e: unknown) =>
            setStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      },
    [onDone],
  );

  if (error) return <Text style={[s.error, s.pad]}>{error}</Text>;
  if (!detail) return <ActivityIndicator style={{ margin: 32 }} />;
  const attention =
    (detail.thread as { attention?: { replyLater?: boolean; setAside?: boolean } }).attention ?? {};
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(8, 0, 0, 0);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1} accessibilityRole="header">
        {detail.thread.subject || "(no subject)"}
      </Text>
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}
        accessibilityLabel="Thread actions"
      >
        <Button label="Reply" primary onPress={onReply} />
        <Button
          label={attention.replyLater ? "Remove from Reply Later" : "Reply Later"}
          onPress={act("Reply Later updated", () =>
            client.attention(mailboxId, threadId, "replyLater", !attention.replyLater),
          )}
        />
        <Button
          label={attention.setAside ? "Done with it" : "Set Aside"}
          onPress={act("Set Aside updated", () =>
            client.attention(mailboxId, threadId, "setAside", !attention.setAside),
          )}
        />
        <Button
          label="Bubble up tomorrow"
          onPress={act("Will bubble up tomorrow", () =>
            client.bubbleUp(mailboxId, threadId, tomorrow.getTime()),
          )}
        />
        <Button
          label="Trash"
          onPress={act("Moved to Trash", () => client.trash(mailboxId, [threadId]), true)}
        />
        <Button
          label="Spam"
          onPress={act("Marked as spam", () => client.spam(mailboxId, [threadId]), true)}
        />
      </View>
      {status ? (
        <Text style={s.muted} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
      {detail.deliveries.map((d) => (
        <View key={d.deliveryId} style={{ marginBottom: 16 }}>
          <Text style={s.text}>{d.from.name || d.from.address}</Text>
          <Text style={s.muted}>{new Date(d.date).toLocaleString()}</Text>
          <SandboxedMessage url={d.renderUrl} title={`Message from ${d.from.address}`} />
          <Attachments delivery={d} client={client} mailboxId={mailboxId} />
        </View>
      ))}
    </ScrollView>
  );
};

/** Attachment list with scan state (E20); downloads are offered only after a clean scan. */
const Attachments = ({
  delivery,
  client,
  mailboxId,
}: {
  delivery: DeliveryWire;
  client: ByeClient;
  mailboxId: string;
}) => {
  const [error, setError] = useState<string | null>(null);
  const files = delivery.attachments ?? [];
  if (files.length === 0) return null;
  const notice = SCAN_NOTICE[delivery.scan?.status ?? ""];
  // The OS opens a short-lived signed link on the render origin; scan status is re-checked on use.
  const open = (partId: string) => async () => {
    setError(null);
    try {
      const { downloadUrl } = await client.attachmentLink(mailboxId, delivery.deliveryId, partId);
      await Linking.openURL(downloadUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    }
  };
  return (
    <View style={{ marginTop: 8 }} accessibilityLabel="Attachments">
      {notice ? <Text style={s.muted}>{notice}</Text> : null}
      {files.map((f) =>
        notice ? (
          <Text key={f.partId} style={s.muted}>{`📎 ${f.filename} (${size(f.size)})`}</Text>
        ) : (
          <Button
            key={f.partId}
            label={`📎 ${f.filename} (${size(f.size)})`}
            onPress={open(f.partId)}
          />
        ),
      )}
      {error ? (
        <Text style={s.muted} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
};

export const SandboxedMessage = ({ url, title }: { url: string; title: string }) => {
  const origin = new URL(url).origin;
  return (
    <WebView
      accessibilityLabel={title}
      style={{ height: 420, marginTop: 8, borderRadius: 8 }}
      source={{ uri: url }}
      originWhitelist={[origin]}
      javaScriptEnabled={false}
      domStorageEnabled={false}
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      incognito
      cacheEnabled={false}
      allowFileAccess={false}
      allowsLinkPreview={false}
      setSupportMultipleWindows={false}
      mixedContentMode="never"
      onShouldStartLoadWithRequest={(request) => {
        if (request.url === url) return true;
        if (/^https?:\/\//.test(request.url) || request.url.startsWith("mailto:"))
          void Linking.openURL(request.url);
        return false;
      }}
    />
  );
};
