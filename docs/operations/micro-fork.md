# Maintaining the Micro Manager fork

The `main` branch contains upstream T3 Code plus desktop session opening,
Micro controls, multi-repository workspaces, and fork additions to side chats.
The fork's GitHub Actions workflow runs daily at 04:37 UTC, on pushes to `main`,
and manually from **Actions → Micro desktop release**.

## Choosing an upstream release

Scheduled runs merge the latest stable upstream release. To move the fork to a
nightly, or to a specific stable release, run **Micro desktop release** manually
and enter its tag in **upstream_ref**, for example `v0.0.46-nightly.20261009.2873`.
Stable releases and nightlies are both cut from upstream `main`, so the fork can
switch between them with ordinary merges. Preview tags are not on `main` and are
rejected.

Merging only moves forward. While `main` includes a nightly that is newer than the
latest stable release, scheduled runs find that release already included and skip
the merge. When a newer stable release appears, the next scheduled run merges it.

`.github/micro-sync-state.json` records the latest checked stable release
(`upstreamRelease`) and the newest upstream tag merged into `main`
(`includedUpstream`). Builds take their version from `includedUpstream`:
`v0.0.46-nightly.20261009.2873` and `v0.0.46` both build as `0.0.46-micro.<run>`.
The run number orders builds for the desktop updater. Do not put the channel in
the version: `-micro` sorts below `-nightly`, so the updater would never offer a
later stable build.

For each new upstream release, the workflow merges its tag, verifies the fork's
tests and affected type checks, and builds an Apple Silicon macOS DMG and ZIP.
The fork's tests are derived from its diff against the included tag: tests it
adds or changes, and existing tests beside source files it changes.
Only a successful build advances `main` with upstream source and publishes a
new release; the monthly check record below is pushed without a build. A failed
source merge is aborted. A failed test or build leaves the published source and
previous release intact. Conflicts and breaking upstream changes still need a
person or agent to resolve them.

This fork owns `.github/workflows`. Upstream's workflows target private runners
and production services, so they are intentionally not imported during sync.
Keeping this directory unchanged also avoids requiring a personal token with
workflow-editing access for automated merges. The update job uses only its
repository-scoped `GITHUB_TOKEN`; no account token or agent credential is stored.
The sync, verification and publication run together because a push using
`GITHUB_TOKEN` does not trigger another push workflow.

When there is no new release, the job skips the expensive build. It records a
successful check once per calendar month, keeping repository activity from going
stale and allowing the schedule to keep running through quiet upstream periods.
Manual runs and pushes build the current fork even when no newer upstream tag
exists. Runs are serialized, and a simultaneous manual source push causes the
automation's normal fast-forward push to fail instead of overwriting changes.

## Database migrations

The fork adds no database migrations. The migrator records ids only and skips
every id at or below the highest recorded one, so a fork migration masks any
future upstream migration that reuses its id. The release workflow fails when
the fork's migration manifest or `apps/server/src/persistence/Migrations/` differ
from the included upstream tag. Keep fork state in files or settings, or add a
separate ledger outside the upstream migrator.

Releases up to `0.0.45-micro` recorded fork migrations as 50, 53 and 55.
`reconcileForkMigrationLedger` repairs those databases before migrations run, so
upstream's `OrchestrationV2` (55) is applied.

## Installing a build

Download the DMG or ZIP from this fork's latest release. Builds are currently
ad-hoc signed and not notarized. The workflow verifies the packaged signature
and that its update feed points to this fork before publication. Source updates
and downloadable builds are automatic; unattended macOS installation is not
guaranteed. The packaged update feed points to `nielsb02/t3code`, so it does not
offer the unpatched upstream app. The app's own update controls remain user
initiated.

Quit the old T3 app before replacing it. The fork uses T3's normal bundle ID and
data location, preserving existing sessions. Do not run a second server against
the same live T3 home. Choose the installed app in **Micro Manager → Configure →
Connection → Desktop app**; a Finder alias or symlink can keep that selection
stable across downloads.

The first build with Orchestration V2 copies `state.sqlite` to `statev2.sqlite`
and uses the copy from then on. See
[threads from older versions](../user/thread-migration.md). An older V1 build
keeps using `state.sqlite`, so switching back shows the state from before the
upgrade.

## Recovering from a failed update

Read the failed workflow step. Reproduce a merge on a branch or isolated worktree,
resolve source conflicts without dropping the fork's changes, and run:

```sh
python3 .github/scripts/micro_sync_test.py
python3 .github/scripts/micro_sync.py check-migrations <upstream-tag>
vp test run apps/server/src/persistence/reconcileV2PreviewMigration.test.ts \
  $(python3 .github/scripts/micro_sync.py fork-tests <upstream-tag>)
```

plus the type checks listed in the workflow's verification step.

Push the fix to this fork's `main` and run **Micro desktop release** again. The
workflow and retained releases provide the source commit and build version for
each download. Changes to this fork's own workflow are maintained directly;
they are not replaced by upstream sync.

## Creator Micro session feed

Micro Manager's **T3 desktop sessions** source requires the fork's local
`list-sessions` desktop protocol, including environment readiness and sidebar
order publication. Keep it in released source: the previously installed app had
this as a local patch, so replacing it with a release without the patch left
Creator Micro connected but showing no sessions. The release workflow covers
the protocol, broker, session snapshot, and navigation behavior.

Session status comes from the sidebar's thread status (`resolveSidebarThreadStatus`),
so an upstream change to sidebar status rules also changes what Micro Manager shows.
Subagent threads are not listed. The published order follows the sidebar: pinned,
active, then the working shelf, limited to the projects the sidebar shows.

## Workspace repositories

A checkout's `t3.json` can declare nested repositories (`repositories.paths` and
`includeSubmodules`). The server lists them through `projects.listRepositories`
and includes them in file search; Git actions, diffs, reviews, and linked pull
requests then target the repository the user picks. See
[working with several repositories](../user/source-control.md#work-with-several-repositories).

The server advertises the `workspaceRepositories` and `workspacePullRequestLinks`
capabilities, so clients skip these paths against an upstream server. Upstream
changes to these areas are the likeliest merge conflicts: `PullRequestService`,
the pull request sync and watch reactors, `WorkspaceEntries`,
`WorkspaceFileSystem`, `ReviewService`, the web chat view, thread details and
diff panels, and the mobile review sections and Git actions.

## Retired fork features

These fork features were replaced by upstream equivalents when the fork moved to
Orchestration V2:

- **Mermaid rendering.** Upstream renders Mermaid blocks natively, with a zoomable
  expanded view, sanitized output, and source fallback. The fork's canvas was
  removed rather than kept as a second renderer.
- **Settlement cleanup actions.** Upstream's `runOnSettle` project action replaces
  the fork's `runOnThreadSettle`.
- **Side chat context transfers.** Side chats are upstream forks. The fork keeps
  only the additions described in [side chats](../user/thread-sidebar.md#side-chats).
  Side chats from earlier builds are imported like any V1 thread: the transcript
  and worktree carry over, but not the link to the parent thread, so they appear
  as ordinary threads and cannot be merged back. Archive the ones still open
  before upgrading if they are no longer needed.
