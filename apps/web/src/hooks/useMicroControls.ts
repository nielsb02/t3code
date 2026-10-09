import { useEffect, useEffectEvent, useState } from "react";
import { flushSync } from "react-dom";

import { createMicroDialController, registerMicroControlHandler } from "../microControls";
import { isTerminalFocused } from "../lib/terminalFocus";

const CONTROL_LABELS = new Map([
  ["project", "Project"],
  ["environment", "Environment"],
  ["workspace", "Workspace"],
  ["branch", "Source branch"],
  ["model", "Model"],
  ["reasoning", "Reasoning"],
  ["permissions", "Permissions"],
  ["options", "Model and permissions"],
]);
const CONTROL_SELECTOR = "[data-micro-dial-control]";
const POPUP_SELECTOR = "[data-micro-dial-popup]";
const EDITOR_SELECTOR = '[data-testid="composer-editor"][contenteditable="true"]';

function visible(element: HTMLElement): boolean {
  return (
    element.getClientRects().length > 0 &&
    !element.closest(
      '[hidden], [inert], [aria-hidden="true"], [data-ending-style], [data-chat-column-maximized-away="true"]',
    ) &&
    getComputedStyle(element).visibility !== "hidden"
  );
}

function available(element: HTMLElement): boolean {
  return visible(element) && !element.matches(':disabled, [aria-disabled="true"], [data-disabled]');
}

export function useMicroControls(options: {
  scope: string | null;
  root: HTMLDivElement | null;
  focusComposer: () => void;
  scroll: (direction: -1 | 1) => void;
  latest: () => void;
  settleThread: () => boolean;
  toggleTerminal: () => boolean;
}) {
  const [hint, updateHint] = useState<{ scope: string | null; text: string } | null>(null);
  const focusComposer = useEffectEvent(options.focusComposer);
  const scroll = useEffectEvent(options.scroll);
  const latest = useEffectEvent(options.latest);
  const settleThread = useEffectEvent(options.settleThread);
  const toggleTerminal = useEffectEvent(options.toggleTerminal);

  useEffect(() => {
    const element = options.root;
    if (!element) return;
    const root = element;
    const setHint = (text: string | null) =>
      updateHint((previous) =>
        text === null
          ? null
          : previous?.scope === options.scope && previous.text === text
            ? previous
            : { scope: options.scope, text },
      );
    let disposed = false;
    let blurFrame: number | null = null;

    function controls() {
      const candidates = Array.from(root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(
        available,
      );
      // A resting and expanded trigger can coexist during composer transitions.
      return Array.from(CONTROL_LABELS.keys()).flatMap((id) => {
        const control = candidates.find((candidate) => candidate.dataset.microDialControl === id);
        return control ? [control] : [];
      });
    }

    function popup(): HTMLElement | null {
      const ids = new Set(
        Array.from(
          root.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
          (control) => control.dataset.microDialControl,
        ),
      );
      return (
        Array.from(document.querySelectorAll<HTMLElement>(POPUP_SELECTOR)).find(
          (candidate) => ids.has(candidate.dataset.microDialPopup) && visible(candidate),
        ) ?? null
      );
    }

    function keyboardTarget(menu: HTMLElement): HTMLElement {
      const combobox = menu.querySelector<HTMLElement>('[role="combobox"]');
      if (combobox) return combobox;
      const active = document.activeElement;
      if (active instanceof HTMLElement && menu.contains(active)) return active;
      return (
        menu.querySelector<HTMLElement>(
          '[role="combobox"], [role="option"][tabindex="0"], [role="menuitemradio"][tabindex="0"], [role="menu"], [role="listbox"]',
        ) ?? menu
      );
    }

    function pickerKey(key: "ArrowDown" | "ArrowUp" | "Enter" | "Escape") {
      const menu = popup();
      if (!menu) return;
      const target = keyboardTarget(menu);
      // Use each picker's keyboard path, including its virtual list and disabled options.
      flushSync(() => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }),
        );
      });
      if (target.isConnected) {
        target.dispatchEvent(
          new KeyboardEvent("keyup", { key, code: key, bubbles: true, cancelable: true }),
        );
      }
    }

    function clearHighlight() {
      for (const element of root.querySelectorAll<HTMLElement>("[data-micro-dial-highlighted]")) {
        delete element.dataset.microDialHighlighted;
      }
    }

    function blur() {
      const active = document.activeElement;
      if (
        active instanceof HTMLElement &&
        (root.contains(active) || active.closest(POPUP_SELECTOR))
      ) {
        active.blur();
      }
      // Keep Base UI's close-focus restoration from reentering settings mode.
      root.focus({ preventScroll: true });
    }

    function leaveSettings() {
      if (blurFrame !== null) window.cancelAnimationFrame(blurFrame);
      blur();
      blurFrame = window.requestAnimationFrame(() => {
        if (!disposed) {
          blur();
          controller.focusChanged(false);
        }
        blurFrame = null;
      });
      setHint("Dial: scroll · Press for latest message");
    }

    const controller = createMicroDialController({
      getControls: () => controls().flatMap((control) => control.dataset.microDialControl ?? []),
      getOpenPicker: () => popup()?.dataset.microDialPopup ?? null,
      highlight: (id) => {
        clearHighlight();
        const control = controls().find((candidate) => candidate.dataset.microDialControl === id);
        if (control) {
          control.dataset.microDialHighlighted = "true";
          setHint(`${CONTROL_LABELS.get(id ?? "") ?? "Settings"} · Press to choose`);
        } else {
          setHint(null);
        }
      },
      openPicker: (id) => {
        const control = controls().find((candidate) => candidate.dataset.microDialControl === id);
        if (!control) return;
        flushSync(() => control.click());
        setHint(`${CONTROL_LABELS.get(id) ?? "Settings"} · Turn to choose · Press to confirm`);
      },
      movePicker: (direction) => pickerKey(direction === 1 ? "ArrowDown" : "ArrowUp"),
      confirmPicker: () => {
        pickerKey("Enter");
        if (!popup()) {
          focusComposer();
          setHint("Turn to choose a setting · Down to scroll");
        }
      },
      closePicker: () => {
        // Suppress focus events throughout the synchronous close and delayed restoration.
        if (blurFrame === null)
          blurFrame = window.requestAnimationFrame(() => {
            blurFrame = null;
          });
        pickerKey("Escape");
      },
      focusComposer: () => {
        if (blurFrame !== null) {
          window.cancelAnimationFrame(blurFrame);
          blurFrame = null;
        }
        focusComposer();
        const editor = root.querySelector<HTMLElement>(EDITOR_SELECTOR);
        if (!editor || !available(editor)) controls()[0]?.focus({ preventScroll: true });
        setHint("Turn to choose a setting · Down to scroll");
      },
      blurComposer: leaveSettings,
      scroll: (direction) => {
        scroll(direction);
        setHint("Dial: scroll · Press for latest message");
      },
      latest: () => {
        latest();
        setHint("Latest message · Down to focus chat");
      },
    });

    function isSettingsTarget(target: EventTarget | null): boolean {
      return (
        target instanceof Element &&
        ((root.contains(target) && !!target.closest(`${EDITOR_SELECTOR}, ${CONTROL_SELECTOR}`)) ||
          (popup()?.contains(target) ?? false))
      );
    }

    function onFocus(event: FocusEvent) {
      if (blurFrame !== null) return;
      controller.focusChanged(isSettingsTarget(event.target));
    }

    function onBlur() {
      queueMicrotask(() => {
        if (!disposed && blurFrame === null)
          controller.focusChanged(isSettingsTarget(document.activeElement));
      });
    }

    controller.focusChanged(isSettingsTarget(document.activeElement));
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    const unregister = registerMicroControlHandler((action) => {
      if (disposed || !document.hasFocus() || (!visible(root) && !popup())) return false;
      // Do not reinterpret hardware input inside unrelated dialogs or the terminal.
      const active = document.activeElement;
      if (
        active instanceof Element &&
        active.closest('[role="dialog"], [role="alertdialog"]') &&
        !popup()?.contains(active)
      )
        return false;
      if (isTerminalFocused()) return action === "terminal-toggle" && toggleTerminal();
      if (
        active instanceof Element &&
        !root.contains(active) &&
        !popup()?.contains(active) &&
        active !== document.body
      )
        return false;
      switch (action) {
        case "latest-message":
          latest();
          setHint("Latest message · Down to focus chat");
          return true;
        case "settle-thread":
          return settleThread();
        case "terminal-toggle":
          return toggleTerminal();
        default:
          return controller.handle(action);
      }
    });

    return () => {
      disposed = true;
      unregister();
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
      if (blurFrame !== null) window.cancelAnimationFrame(blurFrame);
      clearHighlight();
    };
  }, [options.scope, options.root]);

  return hint?.scope === options.scope ? hint.text : null;
}
