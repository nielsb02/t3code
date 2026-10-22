import type {
  EnvironmentId,
  ScopedThreadRef,
  ResolvedKeybindingsConfig,
  RunId,
} from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect } from "react";
import type { Thread } from "../../types";
import { newThreadId } from "../../lib/utils";
import { shortcutLabelForCommand } from "../../keybindings";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSideChats, waitForThreadShell } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { readEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { requestSideChatStart, subscribeSideChatStart } from "./sideChatActionBus";
import { SideChatMenuItems } from "./SideChatMenu";
import type { ChatShortcutCommands } from "./useChatShortcuts";

export function useSideChatActions(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThread: Pick<Thread, "id" | "latestRun"> | null | undefined;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly embedded: boolean;
  readonly isServerThread: boolean;
  readonly activeEnvironmentUnavailable: boolean;
  readonly activeEnvironmentBootstrapComplete: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly setThreadError: (threadId: Thread["id"], message: string | null) => void;
}) {
  const {
    environmentId,
    activeThread,
    activeThreadRef,
    embedded,
    isServerThread,
    activeEnvironmentUnavailable,
    activeEnvironmentBootstrapComplete,
    keybindings,
    setThreadError,
  } = input;
  const startSideChatCommand = useAtomCommand(threadEnvironment.startSideChat, {
    reportFailure: false,
  });
  // A side chat's own side chats are not shown; it has no right panel tabs of its own.
  const sideChats = useSideChats(isServerThread && !embedded ? activeThreadRef : null);
  const sideChatTitlesById = new Map(sideChats.map((sideChat) => [sideChat.id, sideChat.title]));
  useEffect(() => {
    // Before the shell loads, every side chat would read as closed and lose its tab.
    if (!activeThreadRef || embedded || !isServerThread || !activeEnvironmentBootstrapComplete) {
      return;
    }
    useRightPanelStore.getState().reconcileSideChatSurfaces(
      activeThreadRef,
      sideChats.map((sideChat) => sideChat.id),
    );
  }, [activeEnvironmentBootstrapComplete, activeThreadRef, embedded, isServerThread, sideChats]);
  /** Micro fork: fork after `runId`, or the latest finished run, into a side chat tab. */
  const onStartSideChat = async (runId: RunId | null) => {
    if (!activeThread || !activeThreadRef || activeEnvironmentUnavailable || embedded) return;
    const targetThreadId = newThreadId();
    const result = await startSideChatCommand({
      environmentId,
      input: {
        sourceThreadId: activeThread.id,
        targetThreadId,
        runId,
        title: `Side chat ${sideChats.length + 1}`,
      },
    });
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          activeThread.id,
          runId === null && activeThread.latestRun === null
            ? "A side chat starts from a finished answer. Send a message in this thread first."
            : error instanceof Error
              ? error.message
              : "Failed to start a side chat.",
        );
      }
      return;
    }
    if (!(await waitForThreadShell(scopeThreadRef(environmentId, targetThreadId)))) {
      setThreadError(
        activeThread.id,
        "The side chat was created, but its thread data did not reach this client. Reconnect and try again.",
      );
      return;
    }
    useRightPanelStore.getState().openSideChat(activeThreadRef, targetThreadId);
  };
  useEffect(() => {
    if (embedded) return;
    return subscribeSideChatStart(() => void onStartSideChat(null));
  }, [embedded, onStartSideChat]);
  const sideChatShortcutLabel = shortcutLabelForCommand(keybindings, "thread.sideChat");
  const sideChatMenuItems =
    !embedded && isServerThread && activeThreadRef ? (
      <SideChatMenuItems
        parentRef={activeThreadRef}
        shortcutLabel={sideChatShortcutLabel ?? null}
        onNewSideChat={() => void onStartSideChat(null)}
      />
    ) : null;

  const sideChatShortcuts = {
    "thread.sideChat": ({ event }) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
      if (!event.repeat) requestSideChatStart();
    },
  } satisfies ChatShortcutCommands;
  return { onStartSideChat, sideChatTitlesById, sideChatMenuItems, sideChatShortcuts };
}
