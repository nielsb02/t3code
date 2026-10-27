import type { ThreadCheckpointSummary } from "@t3tools/client-runtime/state/thread-checkpoints";
import {
  AuthFilesystemReadScope,
  CheckpointRef,
  EnvironmentId,
  MessageId,
  ThreadId,
  RunId,
  type AuthSessionState,
} from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  session: null as Pick<AuthSessionState, "authenticated" | "scopes"> | null,
  sessionError: null as string | null,
  sessionAtom: {},
  turnDiffs: {} as Readonly<Record<number, string>>,
  effects: [] as Array<() => void>,
  checkpoints: [] as ReadonlyArray<ThreadCheckpointSummary>,
  repositoryFilter: null as string | null,
  entries: [] as Array<{
    repository: { path: string; cwd: string; available: boolean };
    source: {
      id: string;
      kind: "working-tree";
      title: string;
      baseRef: string;
      headRef: null;
      diff: string;
      diffHash: string;
      truncated: boolean;
    };
  }>,
}));

vi.mock("@t3tools/client-runtime/state/thread-checkpoints", () => ({
  deriveThreadCheckpointSummaries: () => state.checkpoints,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.turnDiffs }));
vi.mock("react", () => ({
  useCallback: <A>(callback: A) => callback,
  useEffect: (effect: () => void) => state.effects.push(effect),
  useMemo: <A>(factory: () => A) => factory(),
}));
vi.mock("../../state/session", () => ({
  environmentSession: { sessionStateAtom: () => state.sessionAtom },
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("../../state/use-thread-detail", () => ({
  useSelectedThreadProjection: () => ({ projection: {} }),
}));
vi.mock("../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({ selectedThreadCwd: "/repo" }),
}));
vi.mock("@react-navigation/native", () => ({ useFocusEffect: () => undefined }));
vi.mock("../../state/use-workspace-repositories", () => ({
  useWorkspaceRepositories: () => ({
    repositories: state.entries.map(({ repository }) => repository),
    repositoryFilter: state.repositoryFilter,
    selectRepository: vi.fn(),
    refreshRepositories: vi.fn(),
    repositoryError: null,
  }),
}));
vi.mock("./useWorkspaceReviewSources", () => ({
  useWorkspaceReviewSources: () => ({
    entries: state.entries,
    error: null,
    hasData: state.entries.length > 0,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom === state.sessionAtom ? state.session : null,
    error: atom === state.sessionAtom ? state.sessionError : null,
    isPending: atom === state.sessionAtom && state.session === null,
    refresh: vi.fn(),
  }),
}));
vi.mock("../../state/queries", () => ({
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));
vi.mock("../../state/review", () => ({
  reviewEnvironment: { diffPreview: vi.fn() },
}));
vi.mock("./reviewState", () => ({
  setReviewAsyncError: vi.fn(),
  setReviewGitSections: vi.fn(),
  setReviewSelectedSectionId: vi.fn(),
  setReviewTurnDiff: vi.fn(),
  setReviewTurnDiffLoading: vi.fn(),
}));

import { type ReviewCacheForThread } from "./reviewState";
import { useReviewSections } from "./useReviewSections";

beforeEach(() => {
  vi.clearAllMocks();
  state.effects = [];
  state.turnDiffs = { 1: checkpointDiff };
  state.repositoryFilter = null;
  state.entries = [];
  state.session = { authenticated: true, scopes: [AuthFilesystemReadScope] };
  state.sessionError = null;
  state.checkpoints = [
    {
      runId: RunId.make("turn-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/checkpoints/thread/1"),
      status: "ready",
      files: [],
      assistantMessageId: MessageId.make("message-1"),
      completedAt: "2026-04-01T00:00:00.000Z",
    },
  ];
});

const checkpointDiff = "diff --git a/checkpoint.ts b/checkpoint.ts";
function makeReviewCache(
  kind: "working-tree" | "branch-range" = "working-tree",
): ReviewCacheForThread {
  return {
    threadKey: "environment:thread",
    selectedSectionId: `git:${kind}`,
    expandedFileIdsBySection: {},
    revealedLargeFileIdsBySection: {},
    viewedFileIdsBySection: {},
  };
}

function makeInput(reviewCache = makeReviewCache()) {
  return {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    reviewCache,
  };
}

function renderSections(input: ReturnType<typeof makeInput>) {
  const result = useReviewSections(input);
  const effects = state.effects.splice(0);
  effects.forEach((effect) => effect());
  return result;
}

function repositoryEntry(path: string) {
  return {
    repository: { path, cwd: `/repo/${path}`, available: true },
    source: {
      id: "working-tree",
      kind: "working-tree" as const,
      title: "Dirty worktree",
      baseRef: "HEAD",
      headRef: null,
      diff: `diff for ${path}`,
      diffHash: path,
      truncated: false,
    },
  };
}

it("combines child repository diffs while preserving their repository paths", () => {
  state.entries = [repositoryEntry("projects/api"), repositoryEntry("projects/web")];
  const result = renderSections(makeInput());
  expect(result.selectedSection).toMatchObject({
    diff: "diff for projects/api\ndiff for projects/web",
    subtitle: "All workspace repositories",
    repositoryDiffs: [
      { path: "projects/api", diff: "diff for projects/api", truncated: false },
      { path: "projects/web", diff: "diff for projects/web", truncated: false },
    ],
  });
});

it("filters review sections to the selected repository and keeps its cwd", () => {
  state.entries = [repositoryEntry("projects/api"), repositoryEntry("projects/web")];
  state.repositoryFilter = "projects/web";
  const result = renderSections(makeInput());
  expect(result.selectedSection).toMatchObject({
    diff: "diff for projects/web",
    sourceCwd: "/repo/projects/web",
  });
  expect(result.selectedSection?.repositoryDiffs).toBeUndefined();
});

it("hides child repository diffs after file access is lost and retains checkpoint review", () => {
  const input = makeInput();
  state.entries = [repositoryEntry("projects/api"), repositoryEntry("projects/web")];
  expect(renderSections(input).selectedSection?.repositoryDiffs).toHaveLength(2);
  state.session = { authenticated: true, scopes: [] };
  const denied = renderSections(input);
  expect(denied.reviewSections.map((section) => section.id)).toEqual(["turn:1"]);
  expect(denied.selectedSection?.diff).toBe(checkpointDiff);
  expect(input.reviewCache.selectedSectionId).toBe("git:working-tree");
});
