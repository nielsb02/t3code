import type { MicroControlAction, MicroDialAction } from "@t3tools/contracts";

export type MicroGlobalAction = Extract<
  MicroControlAction,
  "new-thread" | "new-project" | "command-palette"
>;
export type MicroChatAction = Exclude<MicroControlAction, MicroGlobalAction>;
type MicroControlHandler = (action: MicroChatAction) => boolean;
let activeHandler: MicroControlHandler | null = null;
let globalHandler: ((action: MicroGlobalAction) => boolean) | null = null;

export function registerMicroControlHandler(handler: MicroControlHandler): () => void {
  activeHandler = handler;
  return () => {
    if (activeHandler === handler) activeHandler = null;
  };
}

export function executeMicroControl(action: MicroControlAction): boolean {
  switch (action) {
    case "new-thread":
    case "new-project":
    case "command-palette":
      return globalHandler?.(action) ?? false;
    default:
      return activeHandler?.(action) ?? false;
  }
}

export function registerGlobalMicroControlHandler(
  handler: (action: MicroGlobalAction) => boolean,
): () => void {
  globalHandler = handler;
  return () => {
    if (globalHandler === handler) globalHandler = null;
  };
}

export interface MicroDialHost {
  getControls: () => readonly string[];
  getOpenPicker: () => string | null;
  highlight: (id: string | null) => void;
  openPicker: (id: string) => void;
  movePicker: (direction: -1 | 1) => void;
  confirmPicker: () => void;
  closePicker: () => void;
  focusComposer: () => void;
  blurComposer: () => void;
  scroll: (direction: -1 | 1) => void;
  latest: () => void;
}

export function createMicroDialController(host: MicroDialHost) {
  let state: { kind: "reading" } | { kind: "settings"; highlighted: string | null } = {
    kind: "reading",
  };

  function focusChanged(inSettings: boolean) {
    if (inSettings) {
      if (state.kind === "reading") state = { kind: "settings", highlighted: null };
    } else if (host.getOpenPicker() === null) {
      state = { kind: "reading" };
      host.highlight(null);
    }
  }

  function handle(action: MicroDialAction): boolean {
    const picker = host.getOpenPicker();
    if (picker !== null) state = { kind: "settings", highlighted: picker };

    if (action === "composer-toggle") {
      if (state.kind === "reading") {
        state = { kind: "settings", highlighted: null };
        host.focusComposer();
      } else {
        host.closePicker();
        state = { kind: "reading" };
        host.highlight(null);
        host.blurComposer();
      }
      return true;
    }

    switch (action) {
      case "dial-clockwise":
      case "dial-counterclockwise": {
        const direction = action === "dial-clockwise" ? 1 : -1;
        if (picker !== null) {
          host.movePicker(direction);
        } else if (state.kind === "reading") {
          host.scroll(direction);
        } else {
          const controls = host.getControls();
          const index = state.highlighted === null ? -1 : controls.indexOf(state.highlighted);
          const next =
            index < 0
              ? direction === 1
                ? 0
                : controls.length - 1
              : (index + direction + controls.length) % controls.length;
          state.highlighted = controls[next] ?? null;
          host.highlight(state.highlighted);
        }
        return true;
      }
      case "dial-press": {
        if (picker !== null) {
          host.confirmPicker();
        } else if (state.kind === "reading") {
          host.latest();
        } else {
          const controls = host.getControls();
          const selected =
            state.highlighted !== null && controls.includes(state.highlighted)
              ? state.highlighted
              : (controls[0] ?? null);
          state.highlighted = selected;
          host.highlight(selected);
          if (selected !== null) host.openPicker(selected);
        }
        return true;
      }
      default: {
        const unhandled: never = action;
        return unhandled;
      }
    }
  }

  return { handle, focusChanged };
}
