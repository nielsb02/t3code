import { isValidElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  fields: [] as string[],
  fieldIndex: 0,
  canChangeThreadBranch: true,
  navigations: 0,
  child: false,
  status: null as unknown,
  branches: [{ name: "main", current: true, isDefault: true, worktreePath: "/repo/projects/app" }],
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: string) => {
    const index = state.fieldIndex++;
    state.fields[index] ??= initial;
    return [state.fields[index], (value: string) => (state.fields[index] = value)];
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ height: 800, width: 400 }),
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  View: "View",
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: () => state.navigations++ }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));
vi.mock("../../../components/ui/AndroidScreenHeader", () => ({
  AndroidSheetHeader: "AndroidSheetHeader",
}));
vi.mock("../../../components/ui/AppText", () => ({ AppText: "Text", AppTextInput: "TextInput" }));
vi.mock("./gitSheetComponents", () => ({ SheetActionButton: "SheetActionButton" }));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (input: unknown) => {
    state.status = input;
    return { data: { refName: "main" } };
  },
}));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: (input: unknown) => input } }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({ selectedThread: { environmentId: "environment", branch: "main" } }),
}));
vi.mock("../../../state/use-workspace-repositories", () => ({
  useWorkspaceRepositories: () => ({
    selectedThreadCwd: state.child ? "/repo/projects/app" : "/repo",
    selectedThreadWorktreePath: null,
    isChildRepository: state.child,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({
    selectedThreadBranches: state.branches,
    selectedThreadBranchesLoading: false,
    gitOperationLabel: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canChangeThreadBranch: state.canChangeThreadBranch,
    onCreateSelectedThreadBranch: () => Promise.resolve(null),
    onCreateSelectedThreadWorktree: () => Promise.resolve(null),
    onCheckoutSelectedThreadBranch: () => Promise.resolve(null),
  }),
}));

import { GitBranchesSheet } from "./GitBranchesSheet";

type ControlProps = {
  label?: string;
  placeholder?: string;
  onPress?: () => unknown;
  onChangeText?: (value: string) => void;
  value?: string;
  children?: ReactNode;
  disabled?: boolean;
};

function findControl(node: ReactNode, label: string): ControlProps | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const control = findControl(child, label);
      if (control) return control;
    }
    return null;
  }
  if (!isValidElement<ControlProps>(node)) return null;
  if (
    node.props.label === label ||
    node.props.placeholder === label ||
    (label === "checkout" && node.type === "Pressable")
  ) {
    return node.props;
  }
  return findControl(node.props.children, label);
}

function control(label: string) {
  state.fieldIndex = 0;
  const found = findControl(
    GitBranchesSheet({ route: { params: { environmentId: "environment", threadId: "thread" } } }),
    label,
  );
  if (!found) throw new Error(`Missing sheet control: ${label}`);
  return found;
}

describe("repository-scoped branch sheet", () => {
  beforeEach(() => {
    state.fields = [];
    state.fieldIndex = 0;
    state.child = false;
  });

  it("queries the selected child repository and permits its current checkout", () => {
    state.child = true;
    expect(control("checkout").disabled).toBe(false);
    expect(state.status).toEqual({
      environmentId: "environment",
      input: { cwd: "/repo/projects/app" },
    });
    expect(control("Create worktree").disabled).toBe(true);
  });

  it("treats a child checkout as another worktree when selecting the workspace root", () => {
    expect(control("checkout").disabled).toBe(true);
    expect(state.status).toEqual({ environmentId: "environment", input: { cwd: "/repo" } });
  });
});
