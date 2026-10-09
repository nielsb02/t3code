import { describe, expect, it } from "vite-plus/test";

import {
  createMicroDialController,
  registerMicroControlHandler,
  registerGlobalMicroControlHandler,
  executeMicroControl,
} from "./microControls";

function workspace() {
  let controls = ["project", "workspace", "branch", "model", "reasoning", "permissions"];
  let highlighted: string | null = null;
  let picker: string | null = null;
  let pending = 0;
  let selected = 0;
  let scroll = 0;
  let atLatest = false;
  let focused = false;
  const controller = createMicroDialController({
    getControls: () => controls,
    getOpenPicker: () => picker,
    highlight: (id) => {
      highlighted = id;
    },
    openPicker: (id) => {
      picker = id;
      pending = selected;
    },
    movePicker: (direction) => {
      pending += direction;
    },
    confirmPicker: () => {
      selected = pending;
      picker = null;
    },
    closePicker: () => {
      picker = null;
      pending = selected;
    },
    focusComposer: () => {
      focused = true;
    },
    blurComposer: () => {
      focused = false;
    },
    scroll: (direction) => {
      scroll += direction;
    },
    latest: () => {
      atLatest = true;
    },
  });
  return {
    controller,
    state: () => ({ highlighted, picker, pending, selected, scroll, atLatest, focused }),
    setControls: (next: string[]) => {
      controls = next;
    },
  };
}

describe("Micro dial navigation", () => {
  it("scrolls and returns to latest while the composer is unfocused", () => {
    const app = workspace();
    app.controller.handle("dial-clockwise");
    app.controller.handle("dial-clockwise");
    app.controller.handle("dial-counterclockwise");
    app.controller.handle("dial-press");
    expect(app.state()).toMatchObject({ scroll: 1, atLatest: true, selected: 0, picker: null });
  });

  it("requires opening a control and confirming a list item before changing a setting", () => {
    const app = workspace();
    app.controller.focusChanged(true);
    app.controller.handle("dial-clockwise");
    expect(app.state()).toMatchObject({ highlighted: "project", picker: null, scroll: 0 });
    app.controller.handle("dial-press");
    app.controller.handle("dial-clockwise");
    app.controller.handle("dial-clockwise");
    expect(app.state()).toMatchObject({ picker: "project", selected: 0, pending: 2 });
    app.controller.handle("dial-press");
    expect(app.state()).toMatchObject({ picker: null, selected: 2 });
    app.controller.handle("dial-clockwise");
    expect(app.state().highlighted).toBe("workspace");
  });

  it("keeps picker mode when the input blurs into its open menu", () => {
    const app = workspace();
    app.controller.focusChanged(true);
    app.controller.handle("dial-press");
    app.controller.focusChanged(false);
    app.controller.handle("dial-clockwise");
    expect(app.state()).toMatchObject({ scroll: 0, pending: 1, picker: "project" });
  });

  it("joystick down cancels a pending choice and subsequent rotation scrolls", () => {
    const app = workspace();
    app.controller.handle("composer-toggle");
    app.controller.handle("dial-press");
    app.controller.handle("dial-clockwise");
    app.controller.handle("composer-toggle");
    app.controller.handle("dial-clockwise");
    expect(app.state()).toMatchObject({
      focused: false,
      selected: 0,
      pending: 0,
      picker: null,
      highlighted: null,
      scroll: 1,
    });
    app.controller.handle("composer-toggle");
    expect(app.state().focused).toBe(true);
  });

  it("preserves confirmed choices and rechecks available controls after a model change", () => {
    const app = workspace();
    app.setControls(["model", "reasoning", "permissions"]);
    app.controller.focusChanged(true);
    app.controller.handle("dial-press");
    app.controller.handle("dial-clockwise");
    app.controller.handle("dial-press");
    app.setControls(["model", "permissions"]);
    app.controller.handle("dial-clockwise");
    expect(app.state()).toMatchObject({ highlighted: "permissions", selected: 1 });
    app.controller.handle("composer-toggle");
    expect(app.state().selected).toBe(1);
  });

  it("clears stale highlights when the selected control disappears", () => {
    const app = workspace();
    app.setControls(["reasoning"]);
    app.controller.focusChanged(true);
    app.controller.handle("dial-clockwise");
    app.setControls([]);
    app.controller.handle("dial-press");
    expect(app.state()).toMatchObject({ highlighted: null, picker: null, atLatest: false });
  });

  it("returns to scrolling after a normal focus change outside settings", () => {
    const app = workspace();
    app.controller.focusChanged(true);
    app.controller.handle("dial-clockwise");
    app.controller.focusChanged(false);
    app.controller.handle("dial-press");
    expect(app.state()).toMatchObject({ highlighted: null, atLatest: true, picker: null });
  });
});

describe("Micro command registration", () => {
  it("rejects events after the chat unmounts and protects its replacement from stale cleanup", () => {
    expect(executeMicroControl("dial-press")).toBe(false);
    const old = workspace();
    const removeOld = registerMicroControlHandler(
      (action) => action === "dial-clockwise" && old.controller.handle(action),
    );
    const next = workspace();
    const removeNext = registerMicroControlHandler(
      (action) => action === "dial-clockwise" && next.controller.handle(action),
    );
    removeOld();
    expect(executeMicroControl("dial-clockwise")).toBe(true);
    expect(old.state().scroll).toBe(0);
    expect(next.state().scroll).toBe(1);
    removeNext();
    expect(executeMicroControl("dial-press")).toBe(false);
  });

  it("opens global actions without a chat and keeps thread actions unavailable after unmount", () => {
    const delivered: string[] = [];
    const removeGlobal = registerGlobalMicroControlHandler((action) => {
      delivered.push(action);
      return true;
    });
    try {
      expect(executeMicroControl("new-project")).toBe(true);
      expect(executeMicroControl("new-thread")).toBe(true);
      expect(executeMicroControl("command-palette")).toBe(true);
      expect(executeMicroControl("settle-thread")).toBe(false);
      const removeChat = registerMicroControlHandler((action) => {
        delivered.push(action);
        return true;
      });
      expect(executeMicroControl("latest-message")).toBe(true);
      expect(executeMicroControl("terminal-toggle")).toBe(true);
      removeChat();
      expect(executeMicroControl("latest-message")).toBe(false);
      expect(executeMicroControl("terminal-toggle")).toBe(false);
      expect(executeMicroControl("command-palette")).toBe(true);
      expect(delivered).toEqual([
        "new-project",
        "new-thread",
        "command-palette",
        "latest-message",
        "terminal-toggle",
        "command-palette",
      ]);
    } finally {
      removeGlobal();
    }
  });

  it("does not reroute rejected chat actions to a global handler", () => {
    const delivered: string[] = [];
    const removeGlobal = registerGlobalMicroControlHandler((action) => {
      delivered.push(action);
      return true;
    });
    const removeChat = registerMicroControlHandler(() => false);
    expect(executeMicroControl("settle-thread")).toBe(false);
    expect(executeMicroControl("composer-toggle")).toBe(false);
    expect(delivered).toEqual([]);
    removeChat();
    removeGlobal();
  });

  it("protects a replacement global handler from stale cleanup", () => {
    const removeOld = registerGlobalMicroControlHandler(() => false);
    const removeNext = registerGlobalMicroControlHandler(() => true);
    removeOld();
    expect(executeMicroControl("new-thread")).toBe(true);
    removeNext();
    expect(executeMicroControl("new-thread")).toBe(false);
  });
});
