import type { EnvironmentId, ScopedThreadRef, RunId } from "@t3tools/contracts";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useEffect } from "react";
import { useRightPanelStore } from "../../rightPanelStore";
import { useSideChats } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { requestSideChatStart, subscribeSideChatStart } from "./sideChatActionBus";
import { SideChatMenuItems } from "./SideChatMenu";
import type { ChatShortcutCommands } from "./useChatShortcuts";

export function useSideChatActions(input: {
  readonly environmentId: EnvironmentId;
  readonly activeThreadRef: ScopedThreadRef | null;
  readonly embedded: boolean;
  readonly isServerThread: boolean;
  readonly activeEnvironmentBootstrapComplete: boolean;
  readonly onStartSideChat: (runId: RunId | null) => Promise<void>;
}) {
  const {
    environmentId,
    activeThreadRef,
    embedded,
    isServerThread,
    activeEnvironmentBootstrapComplete,
    onStartSideChat,
  } = input;
  const sideChats = useSideChats(isServerThread && !embedded ? activeThreadRef : null);
  const sideChatTitlesById = new Map(sideChats.map((sideChat) => [sideChat.id, sideChat.title]));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reconciles mounted side-chat tabs with the server thread shells
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the mounted parent chat to the global side-chat command
  useEffect(() => {
    if (embedded) return;
    return subscribeSideChatStart(() => void onStartSideChat(null));
  }, [embedded, onStartSideChat]);
  const sideChatMenuItems =
    !embedded && isServerThread && activeThreadRef ? (
      <SideChatMenuItems parentRef={activeThreadRef} />
    ) : null;

  const sideChatShortcuts = {
    "thread.sideChat": ({ event }) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return false;
      if (!event.repeat) requestSideChatStart();
    },
  } satisfies ChatShortcutCommands;
  return { sideChatTitlesById, sideChatMenuItems, sideChatShortcuts };
}
