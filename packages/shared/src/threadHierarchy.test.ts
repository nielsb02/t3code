import { describe, expect, it } from "vite-plus/test";
import { orderThreadsForDeletion, sideChatsByParent } from "./threadHierarchy.ts";

describe("orderThreadsForDeletion", () => {
  it("deletes nested side chats before their ancestors regardless of selection order", () => {
    const threads = [
      { id: "parent" },
      { id: "child", parentThreadId: "parent" },
      { id: "grandchild", parentThreadId: "child" },
    ];
    for (const input of [threads, threads.toReversed()]) {
      expect(orderThreadsForDeletion(input).map((thread) => thread.id)).toEqual([
        "grandchild",
        "child",
        "parent",
      ]);
    }
  });
  it("keeps environments separate and permits partial selections", () => {
    const threads = [
      { id: "parent", environmentId: "a" },
      { id: "child", environmentId: "b", parentThreadId: "parent" },
      { id: "child", environmentId: "a", parentThreadId: "parent" },
    ];
    expect(orderThreadsForDeletion(threads)).toEqual([threads[2], threads[0], threads[1]]);
  });
  it("terminates on malformed cycles without duplicating deletions", () => {
    const threads = [
      { id: "a", parentThreadId: "b" },
      { id: "b", parentThreadId: "a" },
    ];
    expect(orderThreadsForDeletion(threads)).toEqual([threads[1], threads[0]]);
  });
});

describe("sideChatsByParent", () => {
  it("groups live children by their environment and parent, preserving sibling order", () => {
    const child = { id: "child", parentThreadId: "parent", environmentId: "a", archivedAt: null };
    const sibling = { ...child, id: "sibling" };
    const remote = { ...child, environmentId: "b" };
    const groups = sideChatsByParent([
      { ...child, id: "parent", parentThreadId: null },
      child,
      { ...child, id: "archived", archivedAt: "2026-09-14" },
      remote,
      sibling,
    ]);
    expect([...groups.entries()]).toEqual([
      ["a:parent", [child, sibling]],
      ["b:parent", [remote]],
    ]);
  });
  it("keeps children attached even when the parent is absent from the current list", () => {
    const child = { parentThreadId: "missing", environmentId: "a", archivedAt: null };
    expect([...sideChatsByParent([child]).entries()]).toEqual([["a:missing", [child]]]);
  });
});
