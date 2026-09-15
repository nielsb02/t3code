import { resolveSidebarThreadStatus } from "./Sidebar.logic";

export function summarizeSideChatActivity(
  threads: readonly Parameters<typeof resolveSidebarThreadStatus>[0][],
) {
  let working = 0;
  let attention = 0;
  let monitoring = 0;
  for (const thread of threads) {
    const status = resolveSidebarThreadStatus(thread);
    if (status === "working") working += 1;
    else if (status === "monitoring") monitoring += 1;
    else if (status === "approval" || status === "input" || status === "failed") attention += 1;
  }
  return { working, attention, monitoring };
}
