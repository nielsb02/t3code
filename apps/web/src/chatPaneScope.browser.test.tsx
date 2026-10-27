import { useLayoutEffect } from "react";
import { act, render } from "../test/render";
import { describe, expect, it } from "vite-plus/test";

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
import { attachTimelineViewport } from "./components/chat/timelineViewport";

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

describe("conversation pane input ownership", () => {
  it("sends page navigation only to the active pane while both timelines stay mounted", async () => {
    observed.clear();
    useChatPaneFocusStore.setState({ panes: [], activeKey: null });
    await using _screen = await render(<Workspace child="child" />, { router: false });
    using stack = new DisposableStack();
    const navigation: string[] = [];
    for (const key of ["parent", "child"]) {
      const node = document.querySelector<HTMLElement>(`[data-chat-pane-id="${key}"]`);
      if (!node) throw new Error(`Missing ${key} pane`);
      const viewport = attachTimelineViewport(node, {
        ownsInput: (target) => ownsChatPaneInput(key, target),
      });
      stack.defer(viewport.dispose);
      stack.defer(
        viewport.subscribe((event) => {
          if (event.source === "key") navigation.push(key);
        }),
      );
    }
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(navigation).toEqual(["child"]);
    await act(() => useChatPaneFocusStore.getState().activate("parent"));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    expect(navigation).toEqual(["child", "parent"]);
  });

  it("gives a new side chat an independent composer and restores the parent when closed", async () => {
    observed.clear();
    useChatPaneFocusStore.setState({ panes: [], activeKey: null });
    await using screen = await render(<Workspace child={null} />, { router: false });
    expect(activeChatPaneComposer()).toBe(parentComposer);
    await screen.rerender(<Workspace child="child" />);
    expect(observed.get("child")?.composer).not.toBe(parentComposer);
    expect(activeChatPaneComposer()).toBe(observed.get("child")?.composer);
    expect(ownsChatPaneInput("child")).toBe(true);
    expect(ownsChatPaneInput("parent")).toBe(false);
    expect(observed.get("parent")?.active).toBe(false);
    await screen.rerender(<Workspace child={null} />);
    expect(activeChatPaneComposer()).toBe(parentComposer);
    expect(observed.get("parent")?.active).toBe(true);
    expect(useChatPaneFocusStore.getState().panes).toHaveLength(1);
  });

  it("keeps the selected child active when a saved workspace mounts and when tabs switch", async () => {
    observed.clear();
    useChatPaneFocusStore.setState({ panes: [], activeKey: null });
    await using screen = await render(<Workspace child="first" />, { router: false });
    expect(ownsChatPaneInput("first")).toBe(true);
    await screen.rerender(<Workspace child="second" />);
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
    observed.clear();
    useChatPaneFocusStore.setState({ panes: [], activeKey: null });
    await using _screen = await render(<Workspace child="child" />, { router: false });
    const parentPopup = document.createElement("div");
    parentPopup.dataset.chatPaneId = "parent";
    expect(ownsChatPaneInput("parent", parentPopup)).toBe(true);
    expect(ownsChatPaneInput("child", parentPopup)).toBe(false);
    expect(ownsChatPaneInput("child", null)).toBe(true);
  });
});
