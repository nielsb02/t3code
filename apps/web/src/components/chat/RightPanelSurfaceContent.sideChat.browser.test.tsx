import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createRef, useState } from "react";
import { act, render } from "../../../test/render";
import { flushSync } from "react-dom";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { ChatPaneScope, useChatPaneFocusStore } from "../../chatPaneScope";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { RightPanelSurfaceContent } from "./RightPanelSurfaceContent";

// Keep the real panel dispatch, pane ownership and Tiptap lifecycle; the full
// conversation's RPC/query dependencies do not affect editor mounting.
vi.mock("../ChatView", () => ({ default: PaneComposer }));
vi.mock("../../state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/entities")>()),
  useThreadShell: () => ({ lineage: { parentThreadId: "parent" } }),
}));

const environmentId = EnvironmentId.make("side-chat-test");
const parentRef = scopeThreadRef(environmentId, ThreadId.make("parent"));
const noop = () => {};

function PaneComposer({ threadId }: { threadId: ThreadId }) {
  const [value, setValue] = useState("");
  return (
    <ChatPaneScope paneKey={threadId} embedded={threadId !== parentRef.threadId}>
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value={value}
        cursor={value.length}
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        ariaLabel={threadId}
        onChange={setValue}
        onPaste={noop}
      />
    </ChatPaneScope>
  );
}

function Workspace({ child }: { child: string | null }) {
  return (
    <>
      <PaneComposer threadId={parentRef.threadId} />
      <RightPanelSurfaceContent
        surface={
          child
            ? { kind: "side-chat", id: `side-chat:${child}`, threadId: ThreadId.make(child) }
            : null
        }
        activeSurfaceId={child ? `side-chat:${child}` : null}
        threadRef={parentRef}
        environmentId={environmentId}
        visible
        composerDraftTarget={parentRef}
        keybindings={[]}
        configuredPreviewUrls={[]}
        workspaceMutationId={null}
        getShortcutContext={() => ({
          terminalFocus: false,
          terminalOpen: false,
          previewFocus: false,
          previewOpen: false,
          isWeb: true,
          isDesktop: false,
        })}
        onSendAnnotation={noop}
        onCloseSurface={noop}
        terminal={{
          launchContext: null,
          keybindings: [],
          onAddTerminalContext: noop,
          onSplitTerminal: noop,
          onSplitTerminalVertical: noop,
          onNewTerminal: noop,
          onActiveTerminalChange: noop,
          onCloseTerminal: noop,
        }}
        pullRequest={{
          capabilityKnown: true,
          supported: false,
          projectId: null,
          pullRequests: [],
          linkedPullRequest: null,
          branchPullRequest: null,
          onBack: undefined,
        }}
        files={{
          projectName: null,
          workspaceRoot: undefined,
          availableEditors: [],
          pendingSurfaceIds: new Set(),
          onOpenFile: noop,
          onPendingChange: noop,
        }}
      />
    </>
  );
}

it.each([null, "first"])(
  "mounts usable independent editors when opening or restoring a side chat (initial %s)",
  async (initial) => {
    useChatPaneFocusStore.setState({ panes: [], activeKey: null });
    await using screen = await render(<Workspace child={initial} />, { router: false });
    const { container } = screen;
    await act(() => {
      flushSync(() => void screen.rerender(<Workspace child="first" />));
      // A lazy retry starts a concurrent render: Tiptap can dispose an editor
      // before that render commits. Both inputs must be ready in this commit.
      expect(container.querySelectorAll(".tiptap")).toHaveLength(2);
    });
    await userEvent.fill(
      container.querySelector<HTMLElement>('[aria-label="parent"]')!,
      "main draft",
    );
    await userEvent.fill(
      container.querySelector<HTMLElement>('[aria-label="first"]')!,
      "side draft",
    );
    expect(container.querySelector('[aria-label="parent"]')?.textContent).toBe("main draft");
    expect(container.querySelector('[aria-label="first"]')?.textContent).toBe("side draft");
    await act(() => flushSync(() => void screen.rerender(<Workspace child="second" />)));
    expect(container.querySelector('[aria-label="second"]')?.textContent).toBe("");
    await act(() => flushSync(() => void screen.rerender(<Workspace child={null} />)));
    expect(container.querySelectorAll(".tiptap")).toHaveLength(1);
    expect(container.querySelector('[aria-label="parent"]')?.textContent).toBe("main draft");
  },
);
