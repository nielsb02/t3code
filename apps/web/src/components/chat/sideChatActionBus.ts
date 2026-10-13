// Micro fork: lets the command palette and shortcuts start a side chat in the open thread.
const SIDE_CHAT_START_EVENT = "t3:side-chat-start";

export function requestSideChatStart(): void {
  window.dispatchEvent(new Event(SIDE_CHAT_START_EVENT));
}

export function subscribeSideChatStart(listener: () => void): () => void {
  window.addEventListener(SIDE_CHAT_START_EVENT, listener);
  return () => window.removeEventListener(SIDE_CHAT_START_EVENT, listener);
}
