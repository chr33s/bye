import React, { useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import {
  distinctAuthOrigin,
  PROBE_ERRORS,
  type ProbeResult,
  type ValidatedInstance,
} from "../instance/discovery.ts";
import { INSTANCE_URL_ERRORS, type InstanceUrlError } from "../instance/url.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

/**
 * Server selection (spec §10 Instance selection). URL entry, "Open in Bye" links
 * and scanned QR codes all land here with the same validation and confirmation: nothing is saved or
 * selected until the user has seen the normalized address (and any distinct sign-in origin) and
 * confirmed. Confirming only saves the server and starts a new sign-in there.
 */

export const describeProbe = (result: ProbeResult): string => {
  switch (result._tag) {
    case "Valid":
      return "";
    case "Moved":
      return result.location
        ? `This address points somewhere else: ${result.location}. Check that address separately if you trust it.`
        : "This address redirects elsewhere, so it wasn't added.";
    case "Unreachable":
      return "The server couldn't be reached. Check the address and your connection.";
    case "Invalid":
      return result.reason === "invalid-url" && result.detail
        ? (INSTANCE_URL_ERRORS[result.detail as InstanceUrlError] ?? PROBE_ERRORS["invalid-url"])
        : PROBE_ERRORS[result.reason];
  }
};

const movedTarget = (result: ProbeResult | null): string | null =>
  result?._tag === "Moved" && result.location
    ? result.location.replace(/\/\.well-known\/bye-instance$/, "")
    : null;

export const Servers = ({
  saved,
  selectedKey,
  initialUrl,
  notice,
  onCheck,
  onConfirm,
  onSelect,
  onRemove,
  onClose,
}: {
  saved: ReadonlyArray<ValidatedInstance>;
  selectedKey: string | null;
  /** Prefilled from a handoff link or QR code; still validated and confirmed like manual entry. */
  initialUrl?: string | null;
  notice?: string | null;
  onCheck: (url: string) => Promise<ProbeResult>;
  onConfirm: (instance: ValidatedInstance) => Promise<void>;
  onSelect: (key: string) => void;
  onRemove: (instance: ValidatedInstance) => Promise<string>;
  onClose?: () => void;
}) => {
  const [url, setUrl] = useState(initialUrl ?? "");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [removing, setRemoving] = useState<ValidatedInstance | null>(null);
  const [status, setStatus] = useState<string | null>(notice ?? null);

  const check = async (target: string) => {
    setBusy(true);
    setResult(null);
    setStatus(null);
    try {
      setResult(await onCheck(target));
    } finally {
      setBusy(false);
    }
  };

  // A handoff arrives with an address: validate it right away, never save it.
  useEffect(() => {
    if (initialUrl) {
      setUrl(initialUrl);
      void check(initialUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl]);

  const valid = result?._tag === "Valid" ? result.instance : null;
  const authOrigin = valid ? distinctAuthOrigin(valid) : null;
  const moved = movedTarget(result);

  return (
    <ScrollView contentContainerStyle={s.pad} accessibilityLabel="Servers">
      <Text style={s.h1} accessibilityRole="header">
        Servers
      </Text>
      {saved.map((i) => (
        <View key={i.key} style={s.row}>
          <Text style={[s.text, { flex: 1 }]} selectable>
            {i.baseUrl}
            {i.key === selectedKey ? "  (selected)" : ""}
          </Text>
          {i.key !== selectedKey ? <Button label="Use" onPress={() => onSelect(i.key)} /> : null}
          <Button label="Remove" onPress={() => setRemoving(i)} />
        </View>
      ))}
      {removing ? (
        <View style={s.pad} accessibilityLiveRegion="polite">
          <Text style={s.text}>
            {`Remove ${removing.baseUrl} from this device? You'll be signed out and its saved data on this device is cleared. Your account and data on the server are not deleted.`}
          </Text>
          <Button
            label="Remove from this device"
            primary
            onPress={() => {
              const target = removing;
              setRemoving(null);
              void onRemove(target).then(setStatus);
            }}
          />
          <Button label="Cancel" onPress={() => setRemoving(null)} />
        </View>
      ) : null}

      <Text style={s.h2} accessibilityRole="header">
        Add a server
      </Text>
      <Text style={s.muted}>
        Enter your server's address, or scan its QR code with your camera to open it in bye.
      </Text>
      <TextInput
        style={s.input}
        value={url}
        onChangeText={(v) => {
          setUrl(v);
          setResult(null);
        }}
        placeholder="https://mail.example.com"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        accessibilityLabel="Server address"
      />
      <Button
        label={busy ? "Checking…" : "Check server"}
        disabled={busy || !url.trim()}
        onPress={() => void check(url)}
      />

      {valid ? (
        <View style={s.pad} accessibilityLiveRegion="polite">
          <Text style={s.text}>Server address</Text>
          <Text style={s.text} selectable>
            {valid.baseUrl}
          </Text>
          {authOrigin ? (
            <>
              <Text style={s.text}>Sign-in is handled by</Text>
              <Text style={s.text} selectable>
                {authOrigin}
              </Text>
            </>
          ) : null}
          <Text style={s.muted}>
            Only continue if you trust this server. Its operator, not bye, handles your data there.
          </Text>
          <Button
            label="Add and sign in"
            primary
            onPress={() =>
              void onConfirm(valid).catch((e: unknown) =>
                setStatus(e instanceof Error ? e.message : String(e)),
              )
            }
          />
          <Button label="Cancel" onPress={() => setResult(null)} />
        </View>
      ) : result ? (
        <Text style={s.error} accessibilityLiveRegion="polite">
          {describeProbe(result)}
        </Text>
      ) : null}
      {moved ? (
        <Button
          label={`Check ${moved}`}
          onPress={() => {
            setUrl(moved);
            void check(moved);
          }}
        />
      ) : null}
      {status ? (
        <Text style={s.muted} accessibilityLiveRegion="polite">
          {status}
        </Text>
      ) : null}
      {onClose ? <Button label="Done" onPress={onClose} /> : null}
    </ScrollView>
  );
};
