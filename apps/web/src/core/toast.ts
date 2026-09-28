import { h } from "./dom.ts";

// Non-blocking notices (errors, "new version available"). A polite live region announces them;
// they never take focus or cover the page, and each can be dismissed.

const region = (): HTMLElement => {
  let el = document.getElementById("toasts");

  if (!el) {
    el = h("div", { id: "toasts", class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(el);
  }

  return el;
};

export interface ToastAction {
  readonly label: string;
  readonly run: () => void;
}

/** Show a notice; returns a function that removes it. Auto-dismisses unless it has an action. */
export const toast = (
  message: string,
  options: { readonly action?: ToastAction; readonly timeoutMs?: number } = {},
): (() => void) => {
  const box = region();
  const close = () => item.remove();

  const item = h(
    "div",
    { class: "toast" },
    h("span", {}, message),
    options.action
      ? h(
          "button",
          {
            type: "button",
            onclick: () => {
              close();
              options.action!.run();
            },
          },
          options.action.label,
        )
      : null,
    h("button", { type: "button", "aria-label": "Dismiss", onclick: close }, "×"),
  );

  box.append(item);
  const timeout = options.timeoutMs ?? (options.action ? 0 : 8000);

  if (timeout > 0) setTimeout(close, timeout);

  return close;
};
