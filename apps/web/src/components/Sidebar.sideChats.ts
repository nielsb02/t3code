import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/** Keep each visible family together while preserving the order of roots and siblings. */
export function groupSideChats<
  T extends Pick<EnvironmentThreadShell, "id" | "environmentId" | "parentThreadId">,
>(threads: readonly T[]): T[] {
  const key = (thread: T) => `${thread.environmentId}:${thread.id}`;
  const byKey = new Map(threads.map((thread) => [key(thread), thread]));
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    const siblings = children.get(parentKey) ?? [];
    siblings.push(thread);
    children.set(parentKey, siblings);
  }
  const result: T[] = [];
  const visited = new Set<string>();
  const append = (thread: T) => {
    if (visited.has(key(thread))) return;
    visited.add(key(thread));
    result.push(thread);
    for (const child of children.get(key(thread)) ?? []) append(child);
  };
  for (const thread of threads) {
    if (!thread.parentThreadId || !byKey.has(`${thread.environmentId}:${thread.parentThreadId}`))
      append(thread);
  }
  // Preserve visibility even if a malformed remote snapshot contains a cycle.
  for (const thread of threads) append(thread);
  return result;
}
