import { fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type {
  SessionClient,
  SessionState,
} from "../../../../packages/native-shared/src/auth/session.ts";
import { SignIn } from "../../../../packages/native-shared/src/ui/SignIn.tsx";

const fakeSession = (overrides: Partial<SessionClient> = {}) =>
  ({
    beginSignIn: vi.fn(async () => ({})),
    cancelSignIn: vi.fn(),
    restore: vi.fn(async () => ({ _tag: "SignedOut" })),
    ...overrides,
  }) as unknown as SessionClient;

const renderSignIn = (state: SessionState, session: SessionClient | undefined = fakeSession()) => {
  const onChangeServer = vi.fn();

  return render(
    <SignIn
      session={session}
      server="mail.bye.test"
      state={state}
      onChangeServer={onChangeServer}
    />,
  ).then(() => ({ session, onChangeServer }));
};

describe("SignIn", () => {
  it("shows the selected server and starts the browser sign-in", async () => {
    const { session, onChangeServer } = await renderSignIn({ _tag: "SignedOut" });

    expect(screen.getByLabelText("Server mail.bye.test")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your browser" }));
    expect(session!.beginSignIn).toHaveBeenCalledOnce();

    await fireEvent.press(screen.getByRole("button", { name: "Change server" }));
    expect(onChangeServer).toHaveBeenCalledOnce();
  });

  it("while authorizing, hides Change server and offers reopen and cancel", async () => {
    const { session } = await renderSignIn({ _tag: "Authorizing", attemptId: "a1" });

    expect(screen.queryByRole("button", { name: "Change server" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Cancel" }));
    expect(session!.cancelSignIn).toHaveBeenCalledOnce();
    await fireEvent.press(screen.getByRole("button", { name: "Open the browser again" }));
    expect(session!.beginSignIn).toHaveBeenCalledOnce();
  });

  it("surfaces a failed browser launch as the status message", async () => {
    await renderSignIn(
      { _tag: "SignedOut" },
      fakeSession({ beginSignIn: vi.fn(async () => Promise.reject(new Error("No browser"))) }),
    );

    await fireEvent.press(screen.getByRole("button", { name: "Sign in with your browser" }));
    expect(await screen.findByText("No browser")).toBeTruthy();
  });

  it("offers a retry for a locked keychain instead of a sign-in", async () => {
    const { session } = await renderSignIn({ _tag: "StorageError", kind: "StorageUnavailable" });

    expect(screen.getByText(/system keychain is locked/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your browser" })).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(session!.restore).toHaveBeenCalledOnce();
  });

  it("explains why the device was signed out", async () => {
    await renderSignIn({ _tag: "SignedOut", reason: "revoked" });

    expect(screen.getByText("This device was signed out. Sign in again to continue.")).toBeTruthy();
  });

  it("without a session client, shows only the server", async () => {
    await render(
      <SignIn
        session={undefined}
        server="mail.bye.test"
        state={{ _tag: "Loading" }}
        onChangeServer={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Change server" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Sign in with your browser" })).toBeNull();
  });
});
