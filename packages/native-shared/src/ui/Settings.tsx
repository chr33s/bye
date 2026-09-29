import React, { useCallback, useEffect, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import type { ByeClient } from "../client.ts";
import type { JsonObject } from "../json.ts";
import { calendarPanelEnabled } from "../mail-calendar.ts";
import type { DeviceSessionWire } from "../wire.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

/**
 * Settings (E23, E24, A03/DS): notifications on this device, remote images, signed-in devices with revoke,
 * the selected server, sign out, and account deletion on that server. Sign-out, removing a server
 * and deleting an account are separate actions and are never described as one another.
 */
export const Settings = ({
  client,
  mailboxId,
  server,
  onSignOut,
  onManageServers,
  onDeleteAccount,
  push,
}: {
  client: ByeClient;
  mailboxId: string;
  /** The server this account lives on. */
  server: string;
  onSignOut: () => void;
  onManageServers: () => void;
  /** Opens the server's own deletion page for this account; absent when the server has none. */
  onDeleteAccount?: () => void;
  /** Notifications for this account on this device; absent where the app has no push bridge. */
  push?: { readonly enabled: boolean; readonly onChange: (on: boolean) => Promise<void> };
}) => {
  const [prefs, setPrefs] = useState<JsonObject>({});
  const [devices, setDevices] = useState<ReadonlyArray<DeviceSessionWire>>([]);
  const [status, setStatus] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const [p, d] = await Promise.all([
      client.preferences(mailboxId).catch(() => ({})),
      client.devices().catch(() => ({ items: [] })),
    ]);
    setPrefs(p);
    setDevices(d.items);
  }, [client, mailboxId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The route answers `{ preferences, notifications, away }`.
  const values = (prefs.preferences ?? prefs) as Record<string, unknown>;
  const remoteImages = (values.remoteImages ?? "off") !== "off";
  const calendarPanel = calendarPanelEnabled(prefs);
  return (
    <ScrollView style={s.screen} contentContainerStyle={s.pad}>
      <Text style={s.h1} accessibilityRole="header">
        Settings
      </Text>
      {push ? (
        <View style={[s.row, { paddingHorizontal: 0 }]}>
          <Text style={[s.text, { flex: 1 }]}>
            {`Notifications on this device (from ${server.replace(/^https:\/\//, "")})`}
          </Text>
          <Switch
            accessibilityLabel="Notifications on this device"
            value={push.enabled}
            onValueChange={(v) =>
              void push.onChange(v).then(
                () => setStatus(""),
                (e: unknown) => setStatus(e instanceof Error ? e.message : String(e)),
              )
            }
          />
        </View>
      ) : null}
      <View style={[s.row, { paddingHorizontal: 0 }]}>
        <Text style={[s.text, { flex: 1 }]}>Load remote images (through the privacy proxy)</Text>
        <Switch
          accessibilityLabel="Load remote images"
          value={remoteImages}
          onValueChange={(v) =>
            void client
              .setPreference(mailboxId, "remoteImages", v ? "proxy" : "off")
              .then(load, (e: unknown) => setStatus(String(e)))
          }
        />
      </View>
      <View style={[s.row, { paddingHorizontal: 0 }]}>
        <Text style={[s.text, { flex: 1 }]}>
          Calendar panel in the Inbox (today's agenda and next event)
        </Text>
        <Switch
          accessibilityLabel="Calendar panel in the Inbox"
          value={calendarPanel}
          onValueChange={(v) =>
            void client
              .setPreference(mailboxId, "calendarPanel", v)
              .then(load, (e: unknown) => setStatus(String(e)))
          }
        />
      </View>
      <Text style={s.h2} accessibilityRole="header">
        Signed-in apps
      </Text>
      {devices.length === 0 ? <Text style={s.muted}>No other apps signed in.</Text> : null}
      {devices.map((d) => (
        <View key={d.id} style={s.row}>
          <Text
            style={[s.text, { flex: 1 }]}
          >{`${d.deviceName || d.clientId} · last used ${new Date(d.lastUsedAt).toLocaleDateString()}`}</Text>
          <Button
            label="Revoke"
            onPress={() =>
              void client.revokeDevice(d.id).then(load, (e: unknown) => setStatus(String(e)))
            }
          />
        </View>
      ))}
      <Text style={s.muted}>
        Security keys, recovery codes and team settings are managed on the web.
      </Text>
      {status ? <Text style={s.error}>{status}</Text> : null}
      <Text style={s.h2} accessibilityRole="header">
        Server
      </Text>
      <Text style={s.text} selectable>
        {server}
      </Text>
      <Button label="Switch or add server" onPress={onManageServers} />
      <View style={{ marginTop: 16 }}>
        <Button label="Sign out" onPress={onSignOut} />
      </View>
      {onDeleteAccount ? (
        <View style={{ marginTop: 16 }}>
          {confirmDelete ? (
            <>
              <Text style={s.text}>
                {`Delete your account on ${server}? This permanently deletes the account and its mail and calendar on that server, subject to its retention policy. It doesn't affect accounts on other servers. You'll confirm with your passkey on the server's page, which shows whether deletion is pending or complete.`}
              </Text>
              <Button
                label="Continue to delete account"
                primary
                onPress={() => {
                  setConfirmDelete(false);
                  onDeleteAccount();
                }}
              />
              <Button label="Cancel" onPress={() => setConfirmDelete(false)} />
            </>
          ) : (
            <Button label="Delete account…" onPress={() => setConfirmDelete(true)} />
          )}
        </View>
      ) : null}
    </ScrollView>
  );
};
