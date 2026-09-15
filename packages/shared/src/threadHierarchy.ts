/** Live children belong beneath their parent, scoped to the same environment. */
export function sideChatsByParent<
  T extends {
    readonly parentThreadId?: string | null | undefined;
    readonly environmentId: string;
    readonly archivedAt: string | null;
  },
>(threads: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId || thread.archivedAt !== null) continue;
    const key = `${thread.environmentId}:${thread.parentThreadId}`;
    const siblings = children.get(key);
    if (siblings) siblings.push(thread);
    else children.set(key, [thread]);
  }
  return children;
}

/** Children must be removed before parents; ids are local to an environment. */
export function orderThreadsForDeletion<
  T extends {
    readonly id: string;
    readonly parentThreadId?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  const key = (thread: T, id = thread.id) => JSON.stringify([thread.environmentId, id]);
  const children = new Map<string, T[]>();
  for (const thread of threads) {
    if (!thread.parentThreadId) continue;
    const parent = key(thread, thread.parentThreadId);
    const siblings = children.get(parent) ?? [];
    siblings.push(thread);
    children.set(parent, siblings);
  }
  const result: T[] = [];
  const visited = new Set<string>();
  const append = (thread: T) => {
    if (visited.has(key(thread))) return;
    visited.add(key(thread));
    for (const child of children.get(key(thread)) ?? []) append(child);
    result.push(thread);
  };
  for (const thread of threads) append(thread);
  return result;
}
