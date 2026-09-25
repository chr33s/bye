import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { SessionClient, SessionState } from "../auth/session.ts";
import { Button } from "./Button.tsx";
import { s } from "./theme.ts";

/**
 * Sign-in (A03/X01), the same on every native host: the passkey ceremony runs in the system browser
 * on the selected server's HTTPS origin and the app receives an authorization code (PKCE, issuer
 * checked) on its bye:// callback, then holds its own revocable device session for that server.
 * The server address stays visible; there is no token to copy or paste.
 */

const REASONS: Readonly<Record<string, string>> = {
  revoked: "This device was signed out. Sign in again to continue.",
  expired: "Your session expired. Sign in again to continue.",
  cancelled: "Sign-in was cancelled.",
  denied: "Sign-in was declined in the browser.",
  failed: "Sign-in didn't complete. Try again.",
  "corrupt-credential": "Saved sign-in data was unreadable and has been cleared. Sign in again.",
  "logged-out": "You're signed out.",
};

const STORAGE: Readonly<Record<string, string>> = {
  StorageUnavailable: "The system keychain is locked or unavailable. Unlock it and try again.",
  StorageDenied:
    "bye isn't allowed to use the system keychain. Check the app's permissions, then try again.",
  CorruptCredential: "Saved sign-in data was unreadable.",
  MissingCredential: "No saved sign-in was found.",
};

export const describeSession = (state: SessionState): string | null => {
  switch (state._tag) {
    case "SignedOut":
      return state.logoutPending
        ? "Signed out on this device. The server will be notified the next time you're online."
        : state.reason
          ? (REASONS[state.reason] ?? null)
          : null;
    case "StorageError":
      return STORAGE[state.kind] ?? "The system keychain returned an error.";
    case "NotPersisted":
      return "You're signed in, but this device couldn't save your sign-in. You'll need to sign in again after restarting.";
    case "Offline":
      return "You're offline. bye will reconnect automatically.";
    default:
      return null;
  }
};

export const SignIn = ({
  session,
  server,
  state,
  onChangeServer,
}: {
  session: SessionClient | undefined;
  /** The selected server's normalized address, shown before and during sign-in. */
  server: string;
  state: SessionState;
  onChangeServer: () => void;
}) => {
  const [status, setStatus] = useState<string | null>(null);

  const browser = async () => {
    if (!session) return;
    setStatus(null);
    try {
      await session.beginSignIn();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const message = status ?? describeSession(state);
  const authorizing = state._tag === "Authorizing";

  return (
    <ScrollView contentContainerStyle={s.pad} accessibilityLabel="Sign in">
      <Text style={s.h1} accessibilityRole="header">
        Sign in to bye
      </Text>
      <Text style={s.muted}>Server</Text>
      <Text style={s.text} selectable accessibilityLabel={`Server ${server}`}>
        {server}
      </Text>
      {state._tag !== "Authorizing" ? (
        <Button label="Change server" onPress={onChangeServer} />
      ) : null}
      {session ? (
        <View style={{ marginTop: 16 }}>
          {authorizing ? (
            <>
              <Text style={s.text}>
                Finish signing in with your passkey in the browser window that just opened.
              </Text>
              <Button label="Open the browser again" onPress={browser} />
              <Button label="Cancel" onPress={() => session.cancelSignIn()} />
            </>
          ) : state._tag === "StorageError" ? (
            <Button label="Try again" primary onPress={() => void session.restore()} />
          ) : (
            <>
              <Text style={s.muted}>
                bye opens your browser so you can sign in with your passkey. You'll come back here
                automatically.
              </Text>
              <Button label="Sign in with your browser" primary onPress={browser} />
            </>
          )}
        </View>
      ) : null}
      {message ? (
        <Text
          style={state._tag === "Offline" || state._tag === "SignedOut" ? s.muted : s.error}
          accessibilityLiveRegion="polite"
        >
          {message}
        </Text>
      ) : null}
    </ScrollView>
  );
};
