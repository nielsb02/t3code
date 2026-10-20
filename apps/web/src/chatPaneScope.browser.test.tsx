import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ComposerHandleContext,
  useComposerHandleContext,
  type ComposerHandleRef,
} from "./composerHandleContext";
import {
  ChatPaneScope,
  activeChatPaneComposer,
  ownsChatPaneInput,
  useChatPaneActive,
  useChatPaneFocusStore,
} from "./chatPaneScope";

let renderer: Root | null = null;
let container: HTMLDivElement;
const observed = new Map<string, { composer: ComposerHandleRef | null; active: boolean }>();
const parentComposer: ComposerHandleRef = { current: null };

function Probe({ name }: { name: string }) {
  const composer = useComposerHandleContext();
  const active = useChatPaneActive();
  useLayoutEffect(() => {
    observed.set(name, { composer, active });
  }, [name, composer, active]);
  return null;
}

function Workspace({ child }: { child: string | null }) {
  return (
    <ComposerHandleContext value={parentComposer}>
      <ChatPaneScope paneKey="parent" embedded={false}>
        <Probe name="parent" />
        {child ? (
          <ChatPaneScope key={child} paneKey={child} embedded>
            <Probe name={child} />
          </ChatPaneScope>
        ) : null}
      </ChatPaneScope>
    </ComposerHandleContext>
  );
}

beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useChatPaneFocusStore.setState({ panes: [], activeKey: null });
  observed.clear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  container.remove();
  vi.unstubAllGlobals();
});

describe("conversation pane input ownership", () => {
  it("gives a new side chat an independent composer and restores the parent when closed", async () => {
    await act(() => {
      renderer = createRoot(container);
      renderer.render(<Workspace child={null} />);
    });
    expect(activeChatPaneComposer()).toBe(parentComposer);
    await act(() => renderer!.render(<Workspace child="child" />));
    expect(observed.get("child")?.composer).not.toBe(parentComposer);
    expect(activeChatPaneComposer()).toBe(observed.get("child")?.composer);
    expect(ownsChatPaneInput("child")).toBe(true);
    expect(ownsChatPaneInput("parent")).toBe(false);
    expect(observed.get("parent")?.active).toBe(false);
    await act(() => renderer!.render(<Workspace child={null} />));
    expect(activeChatPaneComposer()).toBe(parentComposer);
    expect(observed.get("parent")?.active).toBe(true);
    expect(useChatPaneFocusStore.getState().panes).toHaveLength(1);
  });

  it("keeps the selected child active when a saved workspace mounts and when tabs switch", async () => {
    await act(() => {
      renderer = createRoot(container);
      renderer.render(<Workspace child="first" />);
    });
    expect(ownsChatPaneInput("first")).toBe(true);
    await act(() => renderer!.render(<Workspace child="second" />));
    expect(ownsChatPaneInput("second")).toBe(true);
    expect(ownsChatPaneInput("first")).toBe(false);
    expect(
      useChatPaneFocusStore
        .getState()
        .panes.map((pane) => pane.key)
        .sort(),
    ).toEqual(["parent", "second"]);
    await act(() => useChatPaneFocusStore.getState().activate("parent"));
    expect(activeChatPaneComposer()).toBe(parentComposer);
    expect(observed.get("second")?.active).toBe(false);
  });

  it("routes events from an explicitly tagged pane or popup to that pane only", async () => {
    await act(() => {
      renderer = createRoot(container);
      renderer.render(<Workspace child="child" />);
    });
    const parentPopup = document.createElement("div");
    parentPopup.dataset.chatPaneId = "parent";
    expect(ownsChatPaneInput("parent", parentPopup)).toBe(true);
    expect(ownsChatPaneInput("child", parentPopup)).toBe(false);
    expect(ownsChatPaneInput("child", null)).toBe(true);
  });
});
