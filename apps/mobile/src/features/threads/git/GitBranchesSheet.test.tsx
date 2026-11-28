import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type InputProps = {
  accessibilityLabel: string;
  value: string;
  onChangeText: (value: string) => void;
};
type ActionProps = { label: string; disabled: boolean; onPress: () => void };
const state = vi.hoisted(() => ({
  refName: null as string | null,
  branch: null as string | null,
  child: false,
  status: null as unknown,
  checkoutDisabled: null as boolean | null,
  branches: [] as Array<{
    name: string;
    current: boolean;
    isDefault: boolean;
    worktreePath: string | null;
  }>,
  inputs: new Map<string, InputProps>(),
  actions: new Map<string, ActionProps>(),
  worktrees: [] as Array<{ baseBranch: string; newBranch: string }>,
  focused: true,
  goBackCalls: 0,
  gitResult: Promise.resolve<object | null>(null),
}));

vi.mock("@react-navigation/native", () => ({
  useFocusEffect: () => {},
  useNavigation: () => ({
    goBack: () => state.goBackCalls++,
    isFocused: () => state.focused,
  }),
}));
vi.mock("../../../components/ui/SheetHeader", () => ({ SheetHeader: () => null }));
vi.mock("../../../components/ui/FitSheet", () => ({
  FitSheet: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../native/StackHeader", () => ({ NativeStackScreenOptions: () => null }));
vi.mock("../../../components/ui/FormSection", () => ({
  FormSection: ({ children }: { children: ReactNode }) => children,
  FormField: (props: InputProps) => {
    state.inputs.set(props.accessibilityLabel, props);
    return null;
  },
}));
vi.mock("../../../components/ui/ListSection", () => ({
  ListSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../components/ui/ListChoiceRow", () => ({
  ListChoiceRow: (props: ActionProps) => {
    state.actions.set(props.label, props);
    state.checkoutDisabled = props.disabled;
    return null;
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    state.status = input;
    return { data: state.refName === null ? undefined : { refName: state.refName } };
  },
}));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment", branch: state.branch },
  }),
}));
vi.mock("../../../state/use-workspace-repositories", () => ({
  useWorkspaceRepositories: () => ({
    selectedThreadCwd: state.child ? "/repo/projects/app" : "/repo",
    isChildRepository: state.child,
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: state.branches,
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/queries", () => ({
  usePaginatedBranches: () => ({ data: null, refs: [], isPending: false }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: true,
    onCreateSelectedThreadBranch: () => state.gitResult,
    onCheckoutSelectedThreadBranch: () => state.gitResult,
    onCreateSelectedThreadWorktree: (input: { baseBranch: string; newBranch: string }) => {
      state.worktrees.push(input);
      return state.gitResult;
    },
  }),
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { branch: (input: unknown) => input } }));
vi.mock("./gitSheetComponents", () => ({
  SheetActionButton: (props: ActionProps) => {
    state.actions.set(props.label, props);
    return null;
  },
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

function setup(branch: string | null = null) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.refName = null;
  state.child = false;
  state.status = null;
  state.checkoutDisabled = null;
  state.branches = [
    { name: "release/stable", current: false, isDefault: false, worktreePath: null },
  ];
  state.branch = branch;
  state.inputs.clear();
  state.actions.clear();
  state.worktrees = [];
  state.gitResult = Promise.resolve(null);
  state.focused = true;
  state.goBackCalls = 0;
  const root = createRoot(document.createElement("div"));
  const render = () =>
    act(() => {
      root.render(
        <GitBranchesSheet
          route={{ params: { environmentId: "environment", threadId: "thread" } }}
        />,
      );
    });
  render();
  return {
    render,
    press(label: string) {
      act(() => state.actions.get(label)!.onPress());
    },
    edit(label: string, value: string) {
      act(() => state.inputs.get(label)!.onChangeText(value));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it.each([null, "stale-branch"])(
  "uses the loaded checkout branch when thread metadata is %s",
  (branch) => {
    using screen = setup(branch);
    screen.edit("Worktree branch name", "feature/new-worktree");
    state.refName = "release/stable";
    screen.render();
    screen.press("Create worktree");
    expect(state.worktrees).toEqual([
      { baseBranch: "release/stable", newBranch: "feature/new-worktree" },
    ]);
  },
);

it.each(["custom-base", ""])("preserves an edited base %j when status arrives", (base) => {
  using screen = setup();
  screen.edit("Worktree base branch", base);
  screen.edit("Worktree branch name", "feature/new-worktree");
  state.refName = "release/stable";
  screen.render();
  expect(state.inputs.get("Worktree base branch")!.value).toBe(base);
  expect(state.actions.get("Create worktree")!.disabled).toBe(base === "");
  screen.press("Create worktree");
  expect(state.worktrees).toEqual(
    base === "" ? [] : [{ baseBranch: base, newBranch: "feature/new-worktree" }],
  );
});

it("queries the selected child repository and permits its current checkout", () => {
  using screen = setup();
  state.child = true;
  state.branches = [
    { name: "main", current: true, isDefault: true, worktreePath: "/repo/projects/app" },
  ];
  screen.render();
  expect(state.checkoutDisabled).toBe(false);
  expect(state.status).toEqual({
    environmentId: "environment",
    input: { cwd: "/repo/projects/app" },
  });
  expect(state.actions.get("Create worktree")!.disabled).toBe(true);
});

it("treats a child checkout as another worktree when selecting the workspace root", () => {
  using screen = setup();
  state.branches = [
    { name: "main", current: true, isDefault: true, worktreePath: "/repo/projects/app" },
  ];
  screen.render();
  expect(state.checkoutDisabled).toBe(true);
  expect(state.status).toEqual({ environmentId: "environment", input: { cwd: "/repo" } });
});

it.each(["Create worktree", "Create & checkout", "release/stable"])(
  "does not navigate back when %s finishes after the sheet lost focus",
  async (action) => {
    using screen = setup();
    const gitResult = Promise.withResolvers<object>();
    state.gitResult = gitResult.promise;
    screen.edit("New branch name", "feature/new-branch");
    screen.edit("Worktree branch name", "feature/new-worktree");
    screen.press(action);
    state.focused = false;

    await act(async () => {
      gitResult.resolve({ refName: "feature/ready" });
      await gitResult.promise;
    });
    expect(state.goBackCalls).toBe(0);
  },
);
