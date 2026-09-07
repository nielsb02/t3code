# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.

## Clean up resources when settling a worktree

Select a project, edit an action, and enable **Run when manually settling a worktree**. Use this
for a project command that stops its runtime and removes disposable data. Review the command
before enabling it: it runs with your server account's permissions and may delete resources.
Shared machine actions do not enable settlement cleanup; each project must opt in. Imported
`t3.json` actions can opt in with `"runOnThreadSettle": true`.

The action runs in the thread's worktree with `T3CODE_PROJECT_ROOT`, `T3CODE_WORKTREE_PATH`, and
`T3CODE_THREAD_ID` available. It runs on a new manual settlement, never on automatic settlement
or imported history. Local checkouts and worktrees shared with active threads are skipped.
T3 Code keeps the Git worktree and records progress, output, skips, and failures in the thread.
Each command has a two-minute timeout. While cleanup runs, other threads remain usable, and
T3 Code prevents this checkout from being resumed or changed. A failed command leaves the thread
settled; inspect its output before retrying the action yourself.
