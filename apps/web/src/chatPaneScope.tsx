import { createContext, use, useEffect, useRef, type ReactNode } from "react";
import { create } from "zustand";

import {
  ComposerHandleContext,
  useComposerHandleContext,
  type ComposerHandleRef,
} from "./composerHandleContext";
import type { ChatComposerHandle } from "./components/chat/ChatComposer";

interface Pane {
  key: string;
  composer: ComposerHandleRef;
}

interface PaneFocusState {
  panes: readonly Pane[];
  activeKey: string | null;
  register: (pane: Pane, focus: boolean) => void;
  unregister: (key: string) => void;
  activate: (key: string) => void;
}

export const useChatPaneFocusStore = create<PaneFocusState>((set) => ({
  panes: [],
  activeKey: null,
  register: (pane, focus) =>
    set((state) => ({
      panes: [...state.panes.filter((item) => item.key !== pane.key), pane],
      activeKey: focus || state.activeKey === null ? pane.key : state.activeKey,
    })),
  unregister: (key) =>
    set((state) => {
      const panes = state.panes.filter((pane) => pane.key !== key);
      return {
        panes,
        activeKey: state.activeKey === key ? (panes.at(-1)?.key ?? null) : state.activeKey,
      };
    }),
  activate: (key) =>
    set((state) =>
      state.activeKey !== key && state.panes.some((pane) => pane.key === key)
        ? { activeKey: key }
        : state,
    ),
}));

const ChatPaneKeyContext = createContext<string | null>(null);
export const useChatPaneKey = () => use(ChatPaneKeyContext);
export function useChatPaneActive() {
  const key = useChatPaneKey();
  return useChatPaneFocusStore((state) => key === null || state.activeKey === key);
}

export function ownsChatPaneInput(key: string | null, target?: EventTarget | null): boolean {
  if (key === null) return true;
  const targetKey =
    typeof Element !== "undefined" && target instanceof Element
      ? target.closest<HTMLElement>("[data-chat-pane-id]")?.dataset.chatPaneId
      : undefined;
  return (targetKey ?? useChatPaneFocusStore.getState().activeKey) === key;
}

export function activeChatPaneComposer(): ComposerHandleRef | null {
  const { activeKey, panes } = useChatPaneFocusStore.getState();
  return panes.find((pane) => pane.key === activeKey)?.composer ?? null;
}

/** Conversation resources stay mounted independently; only the focused pane owns global input. */
export function ChatPaneScope({
  paneKey,
  embedded,
  children,
}: {
  paneKey: string;
  embedded: boolean;
  children: ReactNode;
}) {
  const inheritedComposer = useComposerHandleContext();
  const localComposer = useRef<ChatComposerHandle | null>(null);
  const composer = embedded ? localComposer : (inheritedComposer ?? localComposer);
  useEffect(() => {
    useChatPaneFocusStore.getState().register({ key: paneKey, composer }, embedded);
    return () => useChatPaneFocusStore.getState().unregister(paneKey);
  }, [paneKey, composer, embedded]);
  const claim = (target: EventTarget | null) => {
    if (
      target instanceof Element &&
      target.closest<HTMLElement>("[data-chat-pane-id]")?.dataset.chatPaneId === paneKey
    )
      useChatPaneFocusStore.getState().activate(paneKey);
  };
  return (
    <ChatPaneKeyContext value={paneKey}>
      <ComposerHandleContext value={composer}>
        <div
          className="flex min-h-0 min-w-0 flex-1"
          data-chat-pane-id={paneKey}
          onPointerDownCapture={(event) => claim(event.target)}
          onFocusCapture={(event) => claim(event.target)}
        >
          {children}
        </div>
      </ComposerHandleContext>
    </ChatPaneKeyContext>
  );
}
