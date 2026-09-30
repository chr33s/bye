import { act, fireEvent, render, screen } from "@testing-library/react-native";
import React from "react";
import { Linking } from "react-native";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ByeClient } from "../../../../packages/native-shared/src/client.ts";
import { Thread } from "../../../../packages/native-shared/src/ui/Thread.tsx";
import type {
  DeliveryWire,
  ThreadDetailWire,
} from "../../../../packages/native-shared/src/wire.ts";

// The message WebView is a native view; the stand-in keeps its props so the sandbox is asserted.
const webviews = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("react-native-webview", async () => {
  const { View: HostView } = await import("react-native");

  return {
    WebView: (props: Record<string, unknown>) => {
      webviews.push(props);

      return <HostView accessibilityLabel={props.accessibilityLabel as string} />;
    },
  };
});

const RENDER = "https://render.bye.test/m/d1?sig=abc";

const delivery = (overrides: Partial<DeliveryWire> = {}): DeliveryWire =>
  ({
    deliveryId: "d1",
    from: { name: "Ada", address: "ada@bye.test" },
    to: [],
    cc: [],
    subject: "Lunch",
    date: 0,
    snippet: "",
    renderUrl: RENDER,
    ...overrides,
  }) as DeliveryWire;

const detail = (deliveries = [delivery()], attention = {}): ThreadDetailWire =>
  ({
    thread: { threadId: "t1", subject: "Lunch", revision: 7, attention },
    deliveries,
  }) as unknown as ThreadDetailWire;

const fakeClient = (d = detail(), overrides: Record<string, Mock> = {}) => ({
  thread: vi.fn(async () => d),
  markSeen: vi.fn(async () => ({})),
  attention: vi.fn(async () => ({})),
  bubbleUp: vi.fn(async () => ({})),
  trash: vi.fn(async () => ({})),
  spam: vi.fn(async () => ({})),
  attachmentLink: vi.fn(async () => ({ downloadUrl: "https://render.bye.test/a/p1" })),
  messageInvitations: vi.fn(async () => ({ invitations: [] })),
  calendarSearch: vi.fn(async () => ({ items: [] })),
  respondInvitation: vi.fn(async () => ({})),
  calendars: vi.fn(async () => ({ items: [{ calendarId: "cal-1" }] })),
  createEventFromMessage: vi.fn(async () => ({})),
  ...overrides,
});

const renderThread = async (
  client = fakeClient(),
  props: { calendarId?: string; onDone?: () => void } = {},
) => {
  const onReply = vi.fn();
  await render(
    <Thread
      client={client as unknown as ByeClient}
      mailboxId="mbx"
      threadId="t1"
      onReply={onReply}
      {...props}
    />,
  );
  await screen.findByRole("header", { name: "Lunch" });

  return { client, onReply };
};

describe("Thread", () => {
  beforeEach(() => {
    webviews.length = 0;
  });

  it("loads the thread, marks it seen at its revision, and offers reply", async () => {
    const { client, onReply } = await renderThread();

    expect(client.markSeen).toHaveBeenCalledWith("mbx", "t1", 7);
    expect(screen.getByText("Ada")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Reply" }));
    expect(onReply).toHaveBeenCalledOnce();
  });

  it("shows a load failure instead of spinning", async () => {
    await render(
      <Thread
        client={
          fakeClient(detail(), {
            thread: vi.fn(async () => Promise.reject(new Error("gone"))),
          }) as unknown as ByeClient
        }
        mailboxId="mbx"
        threadId="t1"
        onReply={vi.fn()}
      />,
    );

    expect(await screen.findByText("Error: gone")).toBeTruthy();
  });

  it("[§10] renders message HTML only in a sandboxed WebView on the render origin", async () => {
    await renderThread();

    const props = webviews.at(-1)!;
    expect(props).toMatchObject({
      source: { uri: RENDER },
      originWhitelist: ["https://render.bye.test"],
      javaScriptEnabled: false,
      domStorageEnabled: false,
      sharedCookiesEnabled: false,
      thirdPartyCookiesEnabled: false,
      incognito: true,
      cacheEnabled: false,
      allowFileAccess: false,
      mixedContentMode: "never",
    });
    expect(screen.getByLabelText("Message from ada@bye.test")).toBeTruthy();
  });

  it("[§10] sends any navigation away from the message to the system browser", async () => {
    const openURL = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await renderThread();
    const allow = webviews.at(-1)!.onShouldStartLoadWithRequest as (r: { url: string }) => boolean;

    expect(allow({ url: RENDER })).toBe(true);
    expect(allow({ url: "https://evil.test/x" })).toBe(false);
    expect(allow({ url: "mailto:bob@bye.test" })).toBe(false);
    expect(allow({ url: "javascript:alert(1)" })).toBe(false);
    expect(openURL.mock.calls.map(([u]) => u)).toEqual([
      "https://evil.test/x",
      "mailto:bob@bye.test",
    ]);
    openURL.mockRestore();
  });

  it("toggles attention flags from the thread's current state", async () => {
    const { client } = await renderThread(fakeClient(detail([delivery()], { replyLater: true })));

    await fireEvent.press(screen.getByRole("button", { name: "Remove from Reply Later" }));
    expect(client.attention).toHaveBeenCalledWith("mbx", "t1", "replyLater", false);
    expect(await screen.findByText("Reply Later updated")).toBeTruthy();

    await fireEvent.press(screen.getByRole("button", { name: "Set Aside" }));
    expect(client.attention).toHaveBeenCalledWith("mbx", "t1", "setAside", true);
  });

  it("follow up if no reply schedules a conditional bubble for 08:00 tomorrow", async () => {
    const { client } = await renderThread();

    await fireEvent.press(screen.getByRole("button", { name: "Follow up tomorrow if no reply" }));
    const [, , at, condition] = client.bubbleUp.mock.calls[0] as unknown as [
      string,
      string,
      number,
      string,
    ];
    const when = new Date(at);
    expect(condition).toBe("if-no-reply");
    expect([when.getHours(), when.getMinutes()]).toEqual([8, 0]);
    expect(when.getTime()).toBeGreaterThan(Date.now());
  });

  it("trash leaves the thread; a failure stays and says why", async () => {
    const onDone = vi.fn();
    const { client } = await renderThread(undefined, { onDone });

    await fireEvent.press(screen.getByRole("button", { name: "Trash" }));
    expect(client.trash).toHaveBeenCalledWith("mbx", ["t1"]);
    await screen.findByText("Moved to Trash");
    expect(onDone).toHaveBeenCalledOnce();

    client.spam.mockRejectedValueOnce(new Error("offline"));
    await fireEvent.press(screen.getByRole("button", { name: "Spam" }));
    expect(await screen.findByText("Marked as spam failed: offline")).toBeTruthy();
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("[E20] offers attachment downloads only after a clean scan", async () => {
    const attachments = [
      { partId: "p1", filename: "menu.pdf", contentType: "application/pdf", size: 2_097_152 },
    ];
    const openURL = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const { client } = await renderThread(
      fakeClient(detail([delivery({ attachments, scan: { status: "clean" } })])),
    );

    await fireEvent.press(screen.getByRole("button", { name: "📎 menu.pdf (2.0 MB)" }));
    expect(client.attachmentLink).toHaveBeenCalledWith("mbx", "d1", "p1");
    expect(openURL).toHaveBeenCalledWith("https://render.bye.test/a/p1");
    openURL.mockRestore();
  });

  it.each([
    ["pending", "Scanning attachments…"],
    ["infected", "Attachments blocked: a threat was detected."],
    ["failed", "Attachments blocked: they couldn't be scanned."],
  ] as const)("[E20] a %s scan blocks downloads", async (status, notice) => {
    const attachments = [
      { partId: "p1", filename: "x.zip", contentType: "application/zip", size: 10 },
    ];
    await renderThread(fakeClient(detail([delivery({ attachments, scan: { status } })])));

    expect(screen.getByText(notice)).toBeTruthy();
    expect(screen.getByText("📎 x.zip (1 KB)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "📎 x.zip (1 KB)" })).toBeNull();
  });

  it("[C09] answers an invitation and shows the new answer", async () => {
    const client = fakeClient(detail([delivery({ routing: { hasCalendar: true } } as never)]), {
      messageInvitations: vi.fn(async () => ({
        invitations: [
          {
            eventId: "e1",
            occurrenceKey: null,
            summary: "Lunch",
            recurring: false,
            partstat: "NEEDS-ACTION",
            cancelled: false,
          },
        ],
      })),
    });
    await renderThread(client, { calendarId: "space-1" });

    expect(await screen.findByText("Not answered")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Accept" }));
    expect(client.respondInvitation).toHaveBeenCalledWith("space-1", "e1", "ACCEPTED", undefined);
    expect(await screen.findByText("Accepted")).toBeTruthy();
  });

  it("[C09] a cancelled invitation offers no answers", async () => {
    const client = fakeClient(detail([delivery({ routing: { hasCalendar: true } } as never)]), {
      messageInvitations: vi.fn(async () => ({
        invitations: [
          {
            eventId: "e1",
            occurrenceKey: "o1",
            summary: "Lunch",
            recurring: true,
            partstat: "ACCEPTED",
            cancelled: true,
          },
        ],
      })),
    });
    await renderThread(client, { calendarId: "space-1" });

    expect(await screen.findByText("Cancelled by the organizer")).toBeTruthy();
    expect(screen.getByText("Lunch (this occurrence)")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
  });

  it("[C09] creates an event from the message with a backlink, validating the times", async () => {
    const { client } = await renderThread(undefined, { calendarId: "space-1" });

    await fireEvent.press(screen.getByRole("button", { name: "Create event from this message" }));
    expect(screen.getByLabelText("Title").props.value).toBe("Lunch");

    await fireEvent.changeText(screen.getByLabelText("Starts (YYYY-MM-DDTHH:mm)"), "not a time");
    await fireEvent.press(screen.getByRole("button", { name: "Create event" }));
    expect(await screen.findByText(/^start:/)).toBeTruthy();
    expect(client.createEventFromMessage).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByLabelText("Starts (YYYY-MM-DDTHH:mm)"),
      "2030-01-02T12:00",
    );
    await fireEvent.changeText(
      screen.getByLabelText("Ends (YYYY-MM-DDTHH:mm)"),
      "2030-01-02T13:00",
    );
    await act(
      async () => void fireEvent.press(screen.getByRole("button", { name: "Create event" })),
    );
    expect(await screen.findByText("Event created")).toBeTruthy();
    expect(client.createEventFromMessage).toHaveBeenCalledWith(
      "space-1",
      expect.objectContaining({
        calendarId: "cal-1",
        message: expect.objectContaining({ mailboxId: "mbx", threadId: "t1", deliveryId: "d1" }),
      }),
    );
  });

  it("without a calendar space, hides calendar actions", async () => {
    await renderThread(fakeClient(detail([delivery({ routing: { hasCalendar: true } } as never)])));

    expect(screen.queryByLabelText("Invitation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create event from this message" })).toBeNull();
  });
});
