// After-send actions (E08/E09) shared by the web and native composers, so every client offers the
// same choices with the same meaning. The mailbox applies them only once the provider accepts the
// message; a send that fails or is undone leaves the thread untouched.

export type AfterSendChoice = "none" | "done" | "follow-up" | "follow-up-if-no-reply" | "clear";

export type AfterSend =
  | { readonly _tag: "MarkDone" }
  | { readonly _tag: "BubbleUp"; readonly at: number; readonly condition: "always" | "if-no-reply" }
  | { readonly _tag: "ClearBubble" };

export const AFTER_SEND_CHOICES: ReadonlyArray<{
  readonly value: AfterSendChoice;
  readonly label: string;
  /** Only meaningful for a reply in an existing thread. */
  readonly replyOnly: boolean;
}> = [
  { value: "none", label: "Keep in place", replyOnly: false },
  { value: "done", label: "Mark done", replyOnly: true },
  { value: "follow-up", label: "Follow up tomorrow", replyOnly: false },
  { value: "follow-up-if-no-reply", label: "Follow up tomorrow if no reply", replyOnly: false },
  // Send-and-pop: replying resolves the bubble, like ClearBubble (it doesn't resurface the thread).
  { value: "clear", label: "Clear the follow-up", replyOnly: true },
];

const DAY_MS = 24 * 3600_000;

/** The `afterSend` request field for a choice, or undefined for "Keep in place". */
export const afterSendFor = (choice: AfterSendChoice, now: number): AfterSend | undefined => {
  switch (choice) {
    case "none":
      return undefined;
    case "done":
      return { _tag: "MarkDone" };
    case "follow-up":
      return { _tag: "BubbleUp", at: now + DAY_MS, condition: "always" };
    case "follow-up-if-no-reply":
      return { _tag: "BubbleUp", at: now + DAY_MS, condition: "if-no-reply" };
    case "clear":
      return { _tag: "ClearBubble" };
  }
};
