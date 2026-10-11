import { type T3ProjectFile, type WorkspaceRepository } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

export class WorkspaceRepositoryDiscoveryError extends Schema.TaggedError<WorkspaceRepositoryDiscoveryError>()(
  "WorkspaceRepositoryDiscoveryError",
  { cwd: Schema.String, message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** A repository whose files belong to the workspace's file list and search. */
export interface WorkspaceMember {
  /** Workspace-relative path; `.` is the workspace root. */
  readonly path: string;
  readonly cwd: string;
}

type RepositorySettings = NonNullable<T3ProjectFile["repositories"]>;

/**
 * Whether `t3.json` asks for repositories beyond the workspace root. Without any, the workspace
 * is its root alone, exactly as upstream, and membership needs no Git.
 */
const declaresRepositories = (settings: RepositorySettings | undefined): boolean =>
  (settings?.paths?.length ?? 0) > 0 || settings?.includeSubmodules === true;

export class WorkspaceRepositories extends Context.Service<
  WorkspaceRepositories,
  {
    /** Every declared repository with availability and identity. Fails on invalid configuration. */
    readonly list: (
      cwd: string,
    ) => Effect.Effect<ReadonlyArray<WorkspaceRepository>, WorkspaceRepositoryDiscoveryError>;
    /**
     * The root and the available declared repositories, for file lists and search. Never fails:
     * a configuration that cannot be used leaves the root alone and logs a warning, so only the
     * repository picker reports it.
     */
    readonly members: (cwd: string) => Effect.Effect<ReadonlyArray<WorkspaceMember>>;
  }
>()("t3/workspace/WorkspaceRepositories") {}

const decodeProjectFile = Schema.decodeUnknownEffect(T3ProjectFileFromJson);
const isDiscoveryError = Schema.is(WorkspaceRepositoryDiscoveryError);
const REPOSITORY_LIMIT = 1000;
// Searches arrive per keystroke, so membership is reused briefly instead of respawning Git. An
// edited t3.json takes effect at once because its stamp is part of the key; repositories
// created or removed under a declared path are picked up when the entry expires.
const MEMBERSHIP_TTL = "5 seconds";
const MEMBERSHIP_CAPACITY = 256;

const byPath = (a: { readonly path: string }, b: { readonly path: string }) =>
  a.path.localeCompare(b.path);

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcs = yield* VcsProcess.VcsProcess;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  const readSettings = Effect.fn(function* (root: string) {
    const configPath = path.join(root, "t3.json");
    if (!(yield* fs.exists(configPath))) return undefined;
    return (yield* decodeProjectFile(yield* fs.readFileString(configPath))).repositories;
  });

  /** Inspects the workspace whose real path is `root`; `cwd` names it in errors. */
  const workspace = (cwd: string, root: string, operation: string) => {
    const inside = (candidate: string) => {
      const relative = path.relative(root, candidate);
      return (
        !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)
      );
    };
    const resolve = (relative: string) => {
      if (
        path.isAbsolute(relative) ||
        /^[A-Za-z]:/.test(relative) ||
        relative.includes("\\") ||
        relative.split("/").includes("..")
      ) {
        return undefined;
      }
      const candidate = path.resolve(root, relative);
      return inside(candidate) ? candidate : undefined;
    };
    const safeExisting = Effect.fn(function* (candidate: string) {
      if (!(yield* fs.exists(candidate))) return false;
      return inside(yield* fs.realPath(candidate));
    });
    const git = (at: string, args: ReadonlyArray<string>) =>
      vcs.run({
        operation,
        command: "git",
        cwd: at,
        args,
        env: { LC_ALL: "C" },
        allowNonZeroExit: true,
        timeoutMs: 10_000,
      });
    const available = Effect.fn(function* (at: string, exactRoot = true) {
      if (!(yield* safeExisting(at))) return false;
      if (exactRoot && !(yield* fs.exists(path.join(at, ".git")))) return false;
      const result = yield* git(at, ["rev-parse", "--show-toplevel"]);
      if (result.exitCode !== 0 && result.stderr.includes("not a git repository")) return false;
      if (result.exitCode !== 0)
        return yield* new WorkspaceRepositoryDiscoveryError({
          cwd: at,
          message: result.stderr.trim() || "Unable to inspect repository.",
        });
      return !exactRoot || (yield* fs.realPath(result.stdout.trim())) === (yield* fs.realPath(at));
    });
    /** Declared repositories below the root, sorted by path; the root itself is not included. */
    const discover = Effect.fn(function* (settings: RepositorySettings | undefined) {
      const repositories = new Map<string, WorkspaceRepository>();
      const add = Effect.fn(function* (
        relative: string,
        kind: "repository" | "submodule",
        includeMissing: boolean,
      ) {
        const at = resolve(relative);
        if (!at)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${relative}' must stay inside the workspace.`,
          });
        if (at === root)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${relative}' resolves to the workspace root, which is already included.`,
          });
        if ((yield* fs.exists(at)) && !(yield* safeExisting(at))) return;
        const isAvailable = yield* available(at);
        if (!isAvailable && !includeMissing) return;
        const key = path.relative(root, at).split(path.sep).join("/");
        // The root counts towards the limit.
        if (repositories.size + 1 >= REPOSITORY_LIMIT && !repositories.has(key))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Workspace repository limit exceeded (${REPOSITORY_LIMIT}).`,
          });
        repositories.set(key, {
          path: key,
          name: path.basename(at),
          cwd: at,
          kind,
          available: isAvailable,
        });
      });
      for (const pattern of settings?.paths ?? []) {
        if (!resolve(pattern))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${pattern}' must stay inside the workspace.`,
          });
        const wildcard = pattern.endsWith("/*");
        const directory = wildcard ? pattern.slice(0, -2) : pattern;
        if (directory.includes("*") || directory.includes("?") || directory.includes("["))
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Unsupported repository pattern '${pattern}'. Use an explicit path or a trailing /*.`,
          });
        const at = resolve(directory);
        if (!at)
          return yield* new WorkspaceRepositoryDiscoveryError({
            cwd,
            message: `Repository path '${pattern}' must stay inside the workspace.`,
          });
        if (wildcard) {
          if (!(yield* safeExisting(at))) continue;
          for (const name of yield* fs.readDirectory(at)) {
            const child = path.join(at, name);
            if (!(yield* safeExisting(child))) continue;
            if ((yield* fs.stat(child)).type !== "Directory") continue;
            yield* add(path.relative(root, child).split(path.sep).join("/"), "repository", false);
          }
        } else {
          yield* add(directory, "repository", true);
        }
      }
      if (settings?.includeSubmodules) {
        const addSubmodules = Effect.fn(function* (repositoryCwd: string) {
          const modules = path.join(repositoryCwd, ".gitmodules");
          if (!(yield* fs.exists(modules))) return;
          const result = yield* git(repositoryCwd, [
            "config",
            "--null",
            "--file",
            modules,
            "--get-regexp",
            "^submodule\\..*\\.path$",
          ]);
          if (result.exitCode !== 0 && result.exitCode !== 1)
            return yield* new WorkspaceRepositoryDiscoveryError({
              cwd,
              message: result.stderr.trim() || "Unable to read submodule declarations.",
            });
          for (const record of result.stdout.split("\0")) {
            const separator = record.indexOf("\n");
            if (separator < 0) continue;
            const declared = record.slice(separator + 1);
            if (!resolve(declared))
              return yield* new WorkspaceRepositoryDiscoveryError({
                cwd,
                message: `Invalid submodule path '${declared}'.`,
              });
            yield* add(
              path.relative(root, path.resolve(repositoryCwd, declared)).split(path.sep).join("/"),
              "submodule",
              true,
            );
          }
        });
        // The root is read even when it is not a repository; the map grows while it is walked,
        // so initialized submodules are searched for nested ones.
        const inspected = new Set([root]);
        yield* addSubmodules(root);
        for (const repository of repositories.values()) {
          if (!repository.available || inspected.has(repository.cwd)) continue;
          inspected.add(repository.cwd);
          yield* addSubmodules(repository.cwd);
        }
      }
      return [...repositories.values()].sort(byPath);
    });
    return { available, discover };
  };

  const list = Effect.fn("WorkspaceRepositories.list")(
    function* (cwd: string) {
      const root = yield* fs.realPath(cwd);
      const inspect = workspace(cwd, root, "WorkspaceRepositories.list");
      const repositories: ReadonlyArray<WorkspaceRepository> = [
        {
          path: ".",
          name: path.basename(root) || root,
          cwd: root,
          kind: "root",
          available: yield* inspect.available(root, false),
        },
        ...(yield* inspect.discover(yield* readSettings(root))),
      ];
      return yield* Effect.forEach(
        repositories,
        (repository) =>
          Effect.gen(function* () {
            const repositoryIdentity = repository.available
              ? yield* identities.resolve(repository.cwd)
              : null;
            return { ...repository, ...(repositoryIdentity ? { repositoryIdentity } : {}) };
          }),
        { concurrency: 4 },
      );
    },
    Effect.mapError((cause) =>
      isDiscoveryError(cause)
        ? cause
        : new WorkspaceRepositoryDiscoveryError({
            cwd: "workspace",
            message: "Failed to discover workspace repositories.",
            cause,
          }),
    ),
  );

  const membership = (root: string): Effect.Effect<ReadonlyArray<WorkspaceMember>> => {
    const rootOnly: ReadonlyArray<WorkspaceMember> = [{ path: ".", cwd: root }];
    return Effect.gen(function* () {
      const settings = yield* readSettings(root);
      if (!declaresRepositories(settings)) return rootOnly;
      const repositories = yield* workspace(root, root, "WorkspaceRepositories.members").discover(
        settings,
      );
      return [
        ...rootOnly,
        ...repositories.flatMap((repository) =>
          repository.available ? [{ path: repository.path, cwd: repository.cwd }] : [],
        ),
      ];
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to discover workspace repositories; using the root alone", {
          cwd: root,
          cause,
        }).pipe(Effect.as(rootOnly)),
      ),
      Effect.withSpan("WorkspaceRepositories.membership"),
    );
  };

  // Share simultaneous requests; completed discovery is never retained.
  const listFlights = yield* Cache.make({
    lookup: list,
    capacity: 1000,
    timeToLive: "0 millis",
  });
  // Keyed on the root and its t3.json stamp: `${root}\0${stamp}`. Paths cannot contain NUL.
  const memberships = yield* Cache.make({
    lookup: (key: string) => membership(key.slice(0, key.indexOf("\0"))),
    capacity: MEMBERSHIP_CAPACITY,
    timeToLive: MEMBERSHIP_TTL,
  });
  const members = Effect.fn("WorkspaceRepositories.members")(function* (cwd: string) {
    const root = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
    const config = yield* fs.stat(path.join(root, "t3.json")).pipe(Effect.option);
    // Without t3.json there is nothing to discover: no Git, nothing to cache.
    if (Option.isNone(config)) return [{ path: ".", cwd: root }];
    const modified = Option.getOrUndefined(config.value.mtime)?.getTime() ?? "";
    return yield* Cache.get(memberships, `${root}\0${modified}:${config.value.size}`);
  });

  return WorkspaceRepositories.of({
    list: (cwd) => Cache.get(listFlights, cwd),
    members,
  });
});

export const layer = Layer.effect(WorkspaceRepositories, make).pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(RepositoryIdentityResolver.layer),
);
