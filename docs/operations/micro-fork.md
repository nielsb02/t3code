# Maintaining the Micro Manager fork

The `main` branch contains upstream T3 Code plus desktop session opening, Micro
controls, and opt-in project settlement actions. The fork's GitHub Actions workflow runs daily at 04:37 UTC,
on pushes to `main`, and manually from **Actions → Micro desktop release**.

The initial fork includes development commits newer than upstream v0.0.38. The
scheduled job tracks published upstream releases and retains those commits;
it never resets the fork to an older release.

For each new upstream release, the workflow merges its tag, runs the desktop
opening, Micro control, and settlement action tests and affected type checks, and builds an Apple Silicon macOS DMG
and ZIP. Only a successful build advances `main` and publishes a new release.
A failed source merge is aborted. A failed test or build leaves the published
source and previous release intact. GitHub sends workflow failure notifications
according to your account's notification settings. Conflicts and breaking
upstream changes still need a person or agent to resolve them.

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

## Installing a build

Download the DMG or ZIP from this fork's latest release. Builds are currently
ad-hoc signed and not notarized. The workflow verifies the packaged signature
and that its update feed points to this fork before publication. Source updates and downloadable builds are
automatic; unattended macOS installation is not guaranteed. The packaged update
feed points to `nielsb02/t3code`, so it does not offer the unpatched upstream app.
The app's own update controls remain user initiated.

Quit the old T3 app before replacing it. The fork uses T3's normal bundle ID and
data location, preserving existing sessions. Do not run a second server against
the same live T3 home. Choose the installed app in **Micro Manager → Configure →
Connection → Desktop app**; a Finder alias or symlink can keep that selection
stable across downloads.

## Recovering from a failed update

Read the failed workflow step. Reproduce a merge on a branch or isolated worktree,
resolve source conflicts without dropping the desktop opening change, and run:

```sh
python3 .github/scripts/micro_sync_test.py
vp test run apps/web/src/desktopAppActivation.test.ts apps/web/src/microControls.test.ts apps/desktop/src/app/DesktopAppActivation.test.ts apps/desktop/src/app/DesktopAppActivationBroker.test.ts apps/server/src/project/ProjectSettleScriptRunner.test.ts apps/server/src/project/WorktreeOperationGuard.test.ts apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts
vp run --filter @t3tools/contracts --filter @t3tools/shared --filter @t3tools/web --filter @t3tools/desktop --filter t3 typecheck
```

Push the fix to this fork's `main` and run **Micro desktop release** again. The
workflow and retained releases provide the source commit and build version for
each download. Changes to this fork's own workflow are maintained directly;
they are not replaced by upstream sync.

## Mermaid rendering

The fork renders completed Mermaid code blocks in web and desktop chat, with an
expandable canvas, drag navigation, zoom controls, and keyboard navigation. It is
based on [upstream PR #11189](https://github.com/pingdotgg/t3code/pull/11189).
Native mobile continues to show source.

This is a fork override that may be replaced by a future native upstream feature.
When an upstream merge creates a conflict or introduces overlapping Mermaid
support, ask the maintainer to choose whether to retain this implementation as
an override or adopt upstream. Do not automatically discard our canvas or keep
two renderers. Present the relevant behavior differences, including expansion,
pan/zoom, streaming, source fallback, and security, before requesting the choice.
Record the decision here and update the corresponding AGENTS.md rule if the
override is retired. A clean textual merge does not remove this decision point
when both implementations would handle the same blocks.
