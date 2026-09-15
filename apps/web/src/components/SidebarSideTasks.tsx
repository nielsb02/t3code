import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";
import { useSideChatActions } from "../hooks/useSideChatActions";
import { cn } from "../lib/utils";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";
import { summarizeSideChatActivity } from "./Sidebar.sideChats";

const statusLabels = {
  working: "Working",
  monitoring: "Monitoring",
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  ready: "Ready",
} satisfies Record<SidebarThreadStatus, string>;

export function SidebarSideTasks({ threads }: { threads: readonly EnvironmentThreadShell[] }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const { openThread } = useSideChatActions();
  if (threads.length === 0) return null;
  const activity = summarizeSideChatActivity(threads);
  return (
    <div
      data-thread-selection-safe
      className="mx-2 mb-1 text-xs"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
        className="flex min-h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDownIcon aria-hidden className={cn("size-3 shrink-0", !expanded && "-rotate-90")} />
        <span>Side tasks</span>
        <span className="tabular-nums opacity-70">{threads.length}</span>
        <span className="ml-auto flex flex-wrap justify-end gap-x-2 text-[10px]" role="status">
          {activity.working > 0 && (
            <span className="text-sky-600 dark:text-sky-400">{activity.working} working</span>
          )}
          {activity.monitoring > 0 && <span>{activity.monitoring} monitoring</span>}
          {activity.attention > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              {activity.attention} need attention
            </span>
          )}
        </span>
      </button>
      <ul id={listId} hidden={!expanded} className="ml-3 border-l border-sidebar-border pl-2">
        {threads.map((thread) => {
          const status = resolveSidebarThreadStatus(thread);
          return (
            <li key={thread.id}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={() =>
                        void openThread(scopeThreadRef(thread.environmentId, thread.id))
                      }
                      className="flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  <span
                    className={cn(
                      "shrink-0 text-[10px] text-sidebar-muted-foreground",
                      status === "working" && "text-sky-600 dark:text-sky-400",
                      (status === "approval" || status === "input") &&
                        "text-amber-600 dark:text-amber-400",
                      status === "failed" && "text-destructive",
                    )}
                  >
                    {statusLabels[status]}
                  </span>
                </TooltipTrigger>
                <TooltipPopup>{thread.title}</TooltipPopup>
              </Tooltip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
