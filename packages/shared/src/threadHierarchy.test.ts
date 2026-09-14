import { describe, expect, it } from "vite-plus/test";
import { orderThreadsForDeletion } from "./threadHierarchy.ts";

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
