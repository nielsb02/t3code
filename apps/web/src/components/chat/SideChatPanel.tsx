import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useThreadShell } from "../../state/entities";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { useEffect } from "react";
import { hostRightPanel } from "../../rightPanelStore";
import ChatView from "../ChatView";

export default function SideChatPanel(props: {
  readonly parentRef: ScopedThreadRef;
  readonly threadId: ThreadId;
  readonly parentPanel?: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const threadRef = (() => scopeThreadRef(props.parentRef.environmentId, props.threadId))();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- routes the mounted side chat's file and panel actions to its parent
  useEffect(() => hostRightPanel(threadRef, props.parentRef), [threadRef, props.parentRef]);
  const shell = useThreadShell(threadRef);
  if (shell === null || shell.lineage.parentThreadId !== props.parentRef.threadId) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This side chat is no longer available.
      </div>
    );
  }
  return (
    <div data-side-chat-pane className="flex h-full min-h-0 flex-col">
      <ChatView
        environmentId={props.parentRef.environmentId}
        threadId={props.threadId}
        routeKind="server"
        presentation="side-panel"
        {...(props.parentPanel ? { embedded: props.parentPanel } : {})}
        onCloseSideChat={props.onClose}
      />
    </div>
  );
}
