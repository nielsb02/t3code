import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
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

let renderer: ReactTestRenderer | null = null;
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
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useChatPaneFocusStore.setState({ panes: [], activeKey: null });
  observed.clear();
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("conversation pane input ownership", () => {
  it("gives a new side chat an independent composer and restores the parent when closed", async () => {
    await act(() => {
      renderer = create(<Workspace child={null} />);
    });
    expect(activeChatPaneComposer()).toBe(parentComposer);
    await act(() => renderer!.update(<Workspace child="child" />));
    expect(observed.get("child")?.composer).not.toBe(parentComposer);
    expect(activeChatPaneComposer()).toBe(observed.get("child")?.composer);
    expect(ownsChatPaneInput("child")).toBe(true);
    expect(ownsChatPaneInput("parent")).toBe(false);
    expect(observed.get("parent")?.active).toBe(false);
    await act(() => renderer!.update(<Workspace child={null} />));
    expect(activeChatPaneComposer()).toBe(parentComposer);
    expect(observed.get("parent")?.active).toBe(true);
    expect(useChatPaneFocusStore.getState().panes).toHaveLength(1);
  });

  it("keeps the selected child active when a saved workspace mounts and when tabs switch", async () => {
    await act(() => {
      renderer = create(<Workspace child="first" />);
    });
    expect(ownsChatPaneInput("first")).toBe(true);
    await act(() => renderer!.update(<Workspace child="second" />));
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
    class PaneTarget {
      constructor(readonly key: string) {}
      closest() {
        return { dataset: { chatPaneId: this.key } };
      }
    }
    vi.stubGlobal("Element", PaneTarget);
    await act(() => {
      renderer = create(<Workspace child="child" />);
    });
    const parentPopup = new PaneTarget("parent") as unknown as EventTarget;
    expect(ownsChatPaneInput("parent", parentPopup)).toBe(true);
    expect(ownsChatPaneInput("child", parentPopup)).toBe(false);
    expect(ownsChatPaneInput("child", null)).toBe(true);
  });
});
