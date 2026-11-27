import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { sideThreadKindOf } from "@t3tools/client-runtime/side-thread";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { T, useGT } from "gt-react";
import { Trash2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { releaseComposerDraftUploads } from "../../lib/composerDraftUploads";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { readLocalApi } from "../../localApi";
import {
  hostRightPanel,
  rightPanelHostRef,
  type ThreadSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { useQuietThreadProjection, useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentShellStatus } from "../../state/shell";
import { threadEnvironment, useEnvironmentThread } from "../../state/threads";
import {
  isThreadRouteSnapshotAuthoritative,
  resolveThreadRouteRenderState,
} from "../../threadRoutes";
import { useOpenThreadFamily } from "../ThreadRouteView";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatView from "../ChatView";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { BackgroundThreadContext } from "./backgroundThread";
import { closeThreadFindIn } from "./threadFindStore";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

/**
 * A side chat or a subagent as a tab: the thread's own chat, which decides its bottom, the
 * composer or the read-only bar, as it does on the main screen. The tab names it and closes it,
 * so only a side chat, which has actions of its own, gets a header.
 */
export default function SideThreadPane(props: {
  /** The thread whose panel shows the tab. */
  readonly parentRef: ScopedThreadRef;
  readonly surface: ThreadSurface;
  readonly parentPanel: SideChatParentPanel;
  readonly onClose: () => void;
}) {
  const { parentRef, surface } = props;
  const { threadId } = surface;
  const gt = useGT();
  const threadRef = scopeThreadRef(parentRef.environmentId, threadId);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the parent panel as host in the panel store, and closes this side chat's find with its pane
  useEffect(() => {
    const ref = scopeThreadRef(parentRef.environmentId, threadId);
    const unhost = hostRightPanel(ref, parentRef);
    return () => {
      unhost();
      // Crossing the sheet breakpoint remounts the pane in the same commit, which re-hosts it.
      queueMicrotask(() => {
        if (rightPanelHostRef(ref) === ref) closeThreadFindIn(scopedThreadKey(ref));
      });
    };
  }, [parentRef, threadId]);
  const shell = useQuietThreadShell(threadRef);
  const originRef = scopeThreadRef(
    parentRef.environmentId,
    shell?.lineage.parentThreadId ?? parentRef.threadId,
  );
  const parent = useQuietThreadShell(originRef);
  const parentProjection = useQuietThreadProjection(originRef)?.projection;

  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(parentRef.environmentId),
  );
  // The shell can leave an idle subagent out, so its own detail says whether it still exists.
  const unlistedDetail = useEnvironmentThread(
    shell === null ? parentRef.environmentId : null,
    shell === null ? threadId : null,
  );
  useOpenThreadFamily(threadRef, bootstrapComplete && shell === null);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: shell !== null,
    serverThreadDeleted: shell?.deletedAt != null,
    unlistedThreadDetail: unlistedDetail,
    draftThreadExists: false,
  });
  const projection = useQuietThreadProjection(threadRef)?.projection;
  const thread = shell ?? projection?.thread ?? null;
  // A tab opens for side chats and subagents only, so an unloaded one is still one of them.
  const kind = sideThreadKindOf(thread) ?? "subagent";
  const isSideChat = kind === "side-chat";
  const canOperate = useEnvironmentScope(parentRef.environmentId, AuthOrchestrationOperateScope);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, { reportFailure: false });
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const confirmThreadDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const [bringingBack, setBringingBack] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mergeRun = projection ? resolveLatestMergeBackRun(projection) : null;
  // A pending merge-back would fail the main thread's queued message, so the server refuses it.
  const bringBackBlockedReason = !canOperate
    ? gt("This connection cannot change threads.")
    : parent === null || parentProjection === undefined
      ? gt("Waiting for the main thread.")
      : parent.archivedAt !== null
        ? gt("Reopen the main thread first.")
        : threadRuntimeIsActive(parent.runtime)
          ? gt("Available when the main thread is idle.")
          : parentProjection.runs.some((run) => run.status === "queued")
            ? gt("Clear the main thread's queue first.")
            : parentProjection.contextTransfers.some(
                  (transfer) =>
                    transfer.type === "merge_back" &&
                    transfer.status === "pending" &&
                    transfer.targetThreadId === originRef.threadId &&
                    transfer.sourceThreadId !== threadId,
                )
              ? gt("Send the main thread a message to use its pending context first.")
              : mergeRun === null
                ? gt("Available after a finished reply.")
                : null;

  const bringBack = async () => {
    if (bringBackBlockedReason !== null || mergeRun === null || bringingBack || deleting) return;
    setBringingBack(true);
    const result = await mergeBack({
      environmentId: parentRef.environmentId,
      input: { sourceThreadId: threadId, targetThreadId: originRef.threadId, runId: mergeRun.id },
    });
    setBringingBack(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Brought back"),
        description: gt("The main thread gets this side chat with your next message there."),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not bring back the side chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const deleteSideChat = async () => {
    if (!canOperate || shell === null || deleting) return;
    if (confirmThreadDelete) {
      const api = readLocalApi();
      if (!api) return;
      const confirmed = await settlePromise(() =>
        api.dialogs.confirm(
          [
            gt('Delete side chat "{title}"?', { title: shell.title }),
            gt("This permanently clears its conversation history."),
          ].join("\n"),
          { variant: "destructive" },
        ),
      );
      if (confirmed._tag === "Failure" || !confirmed.value) return;
    }
    setDeleting(true);
    const result = await deleteThread({
      environmentId: parentRef.environmentId,
      input: { threadId },
    });
    setDeleting(false);
    if (result._tag === "Success") {
      releaseComposerDraftUploads(threadRef);
      useComposerDraftStore.getState().clearDraftThread(threadRef);
      useRightPanelStore.getState().closeSurface(parentRef, surface.id, { remember: false });
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not delete the side chat"),
        ...(error instanceof Error ? { description: error.message } : {}),
      });
    }
  };

  const title =
    thread === null
      ? isSideChat
        ? gt("Side chat")
        : gt("Subagent")
      : isSideChat
        ? thread.title
        : formatSubagentDisplayTitle(thread.title);

  return (
    <div
      data-side-chat-pane={threadId}
      data-testid="side-thread-pane"
      className="flex h-full min-h-0 flex-col"
    >
      {isSideChat ? (
        <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
          <h2 className="min-w-0 flex-1 truncate text-xs font-medium">{title}</h2>
          <SharedTooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                aria-disabled={
                  bringBackBlockedReason !== null || bringingBack || deleting || undefined
                }
                onClick={() => void bringBack()}
              >
                <T>Bring back</T>
              </Button>
            }
            label={
              bringBackBlockedReason ?? gt("Adds this side chat to the main thread's next message.")
            }
            side="bottom"
          />
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Delete side chat")}
            disabled={!canOperate || shell === null || deleting}
            onClick={() => void deleteSideChat()}
          >
            <Trash2Icon />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={gt("Close side chat")}
            onClick={props.onClose}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      {renderState === "missing" ? (
        <p className="p-3 text-xs text-muted-foreground">
          {isSideChat ? (
            <T>This side chat was deleted.</T>
          ) : (
            <T>This thread is no longer available.</T>
          )}
        </p>
      ) : renderState === "loading" && thread === null ? null : (
        <BackgroundThreadContext value>
          <ChatView
            environmentId={parentRef.environmentId}
            threadId={threadId}
            routeKind="server"
            embedded={props.parentPanel}
            {...(isSideChat ? { onCloseSideChat: props.onClose } : {})}
          />
        </BackgroundThreadContext>
      )}
    </div>
  );
}
