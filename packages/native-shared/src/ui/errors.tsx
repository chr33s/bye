import React from "react";
import { Pressable, SafeAreaView, Text } from "react-native";
import { reportError } from "../errors.ts";
import { s } from "./theme.ts";

// Native error handling (shared by every shell): a React error boundary around the app and a hook
// into React Native's global handler. Both report through the pluggable reporter
// (@bye/native-shared/errors, a no-op unless a host installs one), which never sees mail content.

interface RNErrorUtils {
  getGlobalHandler(): (error: unknown, isFatal?: boolean) => void;
  setGlobalHandler(handler: (error: unknown, isFatal?: boolean) => void): void;
}

let installed = false;

/** Chain onto React Native's global JS error handler (idempotent); the default handler still runs. */
export const installNativeErrorHandler = (): void => {
  const utils = (globalThis as { ErrorUtils?: RNErrorUtils }).ErrorUtils;
  if (installed || !utils) return;
  installed = true;
  const previous = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => {
    reportError(error, isFatal ? "native-fatal" : "native");
    previous(error, isFatal);
  });
};

interface BoundaryState {
  readonly failed: boolean;
}

/** Catches render errors so one broken screen shows a recovery message instead of a blank app. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    reportError(error, "boundary");
  }

  override render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <SafeAreaView style={s.screen}>
        <Text style={[s.pad, s.text]} accessibilityRole="alert">
          Something went wrong. Your drafts are saved on this device.
        </Text>
        <Pressable
          accessibilityRole="button"
          style={s.pad}
          onPress={() => this.setState({ failed: false })}
        >
          <Text style={s.text}>Try again</Text>
        </Pressable>
      </SafeAreaView>
    );
  }
}
