import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type WorkspaceRepository,
  type ExecutionEnvironmentCapabilities,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import { usePullRequestLinking } from "../hooks/usePullRequestLinking";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import { useOpenChangeRequestLink } from "./openPullRequestLink";

const environmentId = EnvironmentId.make("local");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("task"));
const project: EnvironmentProject = {
  id: ProjectId.make("wrapper"),
  environmentId,
  title: "Workspace",
  workspaceRoot: "/workspace",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
};
const thread: EnvironmentThreadShell = {
  id: threadRef.threadId,
  environmentId,
  projectId: project.id,
  title: "Cross-repo feature",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/task",
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-09-18T00:00:00Z",
  updatedAt: "2026-09-18T00:00:00Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const child: WorkspaceRepository = {
  path: "projects/api",
  name: "api",
  cwd: "/task/projects/api",
  kind: "repository",
  available: true,
  repositoryIdentity: {
    provider: "github",
    canonicalKey: "github.com/acme/api",
    displayName: "acme/api",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/acme/api.git",
    },
  },
};
let repositories: readonly WorkspaceRepository[] = [child];
const capabilities: ExecutionEnvironmentCapabilities = {
  repositoryIdentity: false,
  pullRequests: true,
  threadPullRequests: true,
  workspaceRepositories: true,
  workspacePullRequestLinks: true,
};
const configs = new Map([[environmentId, { environment: { capabilities } }]]);
let currentThread = thread;
const mutations: unknown[] = [];

vi.mock("../state/entities", () => ({
  useProjects: () => [project],
  useThreadShell: (ref: typeof threadRef | null) => (ref?.threadId === thread.id ? thread : null),
  readThreadShell: (ref: typeof threadRef) =>
    ref.threadId === currentThread.id ? currentThread : null,
  useServerConfigs: () => configs,
}));
vi.mock("../state/environments", () => ({ usePrimaryEnvironmentId: () => environmentId }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("../browser/useOpenLink", () => ({ useOpenLink: () => () => Promise.resolve() }));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    listRepositories: ({ input }: { input: { cwd: string } }) =>
      Atom.make(AsyncResult.success({ repositories: input.cwd === "/task" ? repositories : [] })),
  },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: {
    linkPullRequest: "link",
    unlinkPullRequest: "unlink",
    updateMetadata: "metadata",
  },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async (input: unknown) => {
    mutations.push(input);
    return { _tag: "Success", value: undefined };
  },
}));

beforeEach(() => {
  configs.set(environmentId, { environment: { capabilities } });
  currentThread = thread;
  repositories = [child];
  mutations.length = 0;
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
});

async function withHooks(
  check: (hooks: {
    open: ReturnType<typeof useOpenChangeRequestLink>;
    linking: ReturnType<typeof usePullRequestLinking>;
  }) => Promise<void> | void,
  bindThread = true,
) {
  const registry = AtomRegistry.make();
  let hooks: Parameters<typeof check>[0] | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    const open = useOpenChangeRequestLink(bindThread ? threadRef : undefined);
    const linking = usePullRequestLinking(environmentId, threadRef);
    useEffect(() => {
      hooks = { open, linking };
    }, [open, linking]);
    return null;
  }
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <Probe />
        </RegistryContext.Provider>,
      );
    });
    if (!hooks) throw new Error("Hooks did not mount");
    const mountedHooks = hooks;
    await act(async () => check(mountedHooks));
  } finally {
    await act(async () => renderer?.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
}

it("opens a child PR beside the thread without a registered project for the child", async () => {
  await withHooks(({ open }) => {
    expect(
      open(
        { preventDefault() {}, stopPropagation() {}, metaKey: false, ctrlKey: false },
        "https://github.com/acme/api/pull/12",
      ),
    ).toBe(true);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      projectId: project.id,
      host: "github.com",
      repository: "acme/api",
      number: 12,
    });
  });
});

it("links a child PR to the wrapper's thread", async () => {
  await withHooks(async ({ linking }) => {
    expect(linking.canLink("https://github.com/acme/api/pull/12")).toBe(true);
    await linking.changeLink(threadRef, "https://github.com/acme/api/pull/12", true);
    expect(mutations).toEqual([
      {
        environmentId,
        input: {
          threadId: threadRef.threadId,
          host: "github.com",
          repository: "acme/api",
          number: 12,
          url: "https://github.com/acme/api/pull/12",
          source: "manual",
        },
      },
    ]);
  });
});

it.each(["https://github.other.test/acme/api/pull/12", "https://github.com/acme/other/pull/12"])(
  "does not route an unrelated PR through a child repository: %s",
  async (url) => {
    await withHooks(({ open, linking }) => {
      expect(linking.canLink(url)).toBe(false);
      expect(
        open({ preventDefault() {}, stopPropagation() {}, metaKey: false, ctrlKey: false }, url),
      ).toBe(false);
    });
  },
);

it("does not offer an unavailable child repository", async () => {
  repositories = [{ ...child, available: false }];
  await withHooks(({ linking }) =>
    expect(linking.canLink("https://github.com/acme/api/pull/12")).toBe(false),
  );
});

it.each([
  ["http://code.example:3000/git/team/repo/pulls/12", true],
  ["http://code.example:4000/git/team/repo/pulls/12", false],
  ["http://other.example:3000/git/team/repo/pulls/12", false],
  ["http://code.example:3000/other/team/repo/pulls/12", false],
])("matches the child's resolved Forgejo address: %s", async (url, expected) => {
  repositories = [
    {
      ...child,
      repositoryIdentity: {
        provider: "forgejo",
        canonicalKey: "ssh.code.example/team/repo",
        displayName: "team/repo",
        webUrl: "http://code.example:3000/git/team/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@ssh.code.example:team/repo.git",
        },
      },
    },
  ];
  await withHooks(({ open, linking }) => {
    expect(linking.canLink(url)).toBe(expected);
    expect(
      open({ preventDefault() {}, stopPropagation() {}, metaKey: false, ctrlKey: false }, url),
    ).toBe(expected);
  });
});

it("keeps child links external on servers without workspace link routing", async () => {
  configs.set(environmentId, {
    environment: {
      capabilities: {
        repositoryIdentity: false,
        pullRequests: true,
        threadPullRequests: true,
        workspaceRepositories: true,
      },
    },
  });
  await withHooks(({ open, linking }) => {
    const url = "https://github.com/acme/api/pull/12";
    expect(linking.canLink(url)).toBe(false);
    expect(
      open({ preventDefault() {}, stopPropagation() {}, metaKey: false, ctrlKey: false }, url),
    ).toBe(false);
  });
});

it("opens a saved child PR from a sidebar without mounting its workspace first", async () => {
  currentThread = {
    ...thread,
    pullRequests: [
      {
        host: "github.com",
        repository: "acme/api",
        number: 12,
        url: "https://github.com/acme/api/pull/12",
        source: "created",
        linkedAt: "2026-09-18T00:00:00Z",
        snapshot: null,
        stack: null,
      },
    ],
  };
  await withHooks(({ open }) => {
    expect(
      open(
        { preventDefault() {}, stopPropagation() {}, metaKey: false, ctrlKey: false },
        "https://github.com/acme/api/pull/12",
        threadRef,
      ),
    ).toBe(true);
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({
      projectId: project.id,
      host: "github.com",
      repository: "acme/api",
      number: 12,
    });
  }, false);
});
