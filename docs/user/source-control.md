# Source control

T3 Code integrates with GitHub, GitLab, Forgejo, Gitea, Bitbucket, and Azure DevOps to clone and publish
repositories, create pull requests, and review changes.

## Work with several repositories

In **Settings → Projects**, select a project and edit **Repository paths** and **Include Git submodules** under **Checkout**. Save writes to that checkout’s `t3.json`, preserving comments and other settings. Existing task worktrees keep their own configuration.

T3 checks that `t3.json` still matches the version read for the save and handles T3 saves one
at a time. If that check fails, the save is rejected; reload the settings and retry.
An external editor can still change the file between T3’s final check and write, so avoid editing
`t3.json` in T3 and an external editor at the same time.

You can also declare repositories directly in `t3.json`, alongside any existing scripts:

```json
{
  "repositories": {
    "paths": ["projects/*"],
    "includeSubmodules": true
  }
}
```

Paths resolve from the current thread's checkout. `projects/*` includes only immediate child
repository roots, including linked Git worktrees. Explicit paths such as `apps/backend` also work.
Recursive patterns and paths outside the workspace are not supported. Other worktrees of those
repositories are not included. `includeSubmodules` includes declared submodules; uninitialized
submodules appear as unavailable.

Files and search include these repositories even when the outer workspace ignores their parent
directory. Each repository keeps its own ignore rules. After adding or removing a repository,
return focus to T3 or refresh the panel to discover the change. Completed agent file and command
operations also refresh discovery.

Choose a repository beside the Git controls before committing or pushing. The agent and terminals
keep the outer workspace as their working directory. The Diff panel shows all repositories by
default, with a repository filter and a separate branch comparison base for each repository.

On web and desktop, the workspace Pull requests panel has a tab for each repository's checked-out
branch. Switch tabs to review its PR, or use that repository's Git actions to create one. This lists
PRs associated with the current workspace branches, rather than every open PR on each remote.

On mobile, select a repository in Git actions. Live and branch review can show all repositories
or a selected repository. Open that repository's PR using the existing browser action.

Turn diffs and checkpoint restore still apply only to the outer workspace repository.

## Connect an account

Install Git and configure authentication on the machine running your T3 Code server. For a remote
environment, do this on the remote machine. After signing in, open **Settings → Source Control**
and choose **Rescan**.

### GitHub

Install [GitHub CLI](https://cli.github.com/) 2.81.0 or newer, then sign in:

```bash
gh auth login
```

### Forgejo and Gitea

Install [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli) or
[Gitea CLI (`tea`)](https://gitea.com/gitea/tea) 0.16 or later on your T3 Code server.
Sign in with `fj --host https://your-server auth add-token` or `tea login add`.
Repeat for each server you use, including Codeberg.

T3 Code prefers a matching `fj` login and falls back to `tea` when `fj` is unavailable
or has no login for that server. Once an account is selected, failed actions stay on that
account. Settings shows the detected CLI. Forgejo and Gitea share one integration entry.
Servers hosted under a URL subpath, such as `https://example.com/forgejo`, use `tea` because
fj 0.6 does not preserve the subpath when checking its account.

When cloning or publishing, use a full repository URL to select a specific server.
You can use `owner/repo` when only one fj server is configured, or with your default `tea`
login when fj is unavailable or unconfigured. With multiple fj servers, use the full URL.
If you have multiple `tea` accounts on one server, select one with
`tea login default <login-name>`. Git push and clone also need Git credentials or an SSH key
for that server.

### GitLab

Install [GitLab CLI](https://gitlab.com/gitlab-org/cli), then sign in:

```bash
glab auth login
```

### Bitbucket

Open **Settings → Source Control**, expand **Bitbucket**, and choose how to sign in:

- **Access token**: a token created for one repository, project, or workspace. It can only reach
  what it was created for.
- **API token**: an Atlassian API token for your account, used with your account email. It can
  reach every repository you can. Give it read/write access to repositories and pull requests, plus
  user read access (`read:user:bitbucket`).

Choose **Save**; the change applies right away, and replaces any credential saved with the other
method. Credentials are saved on the environment's server, so select a remote environment to
configure it. Saved tokens can't be viewed again; enter a new one to replace it, or choose
**Remove**.

If no credentials are saved, T3 Code falls back to these variables in the server's environment.
Restart the server after changing them:

```bash
export T3CODE_BITBUCKET_ACCESS_TOKEN="your-access-token"
# or
export T3CODE_BITBUCKET_EMAIL="you@example.com"
export T3CODE_BITBUCKET_API_TOKEN="your-token"
```

### Azure DevOps

Install [Azure CLI](https://learn.microsoft.com/en-us/cli/azure/), add the DevOps extension, and sign in:

```bash
az extension add --name azure-devops
az login
```

## Start, clone, or publish a project

To start from nothing, choose **New project** in the command palette (`Cmd/Ctrl+K`), or
**New project** under **Add Project** on any client, and type a name. T3 Code makes a Git
repository in `~/.t3/projects` (the `projects` folder of your T3 data directory) with a README,
an icon, and a first commit, then opens a new thread in it. The folder is named after the project,
like `pinball-stats` for "Pinball Stats". Turn on **Create private repository on GitHub** to also
publish it. If Git has no name or email on that machine, the project is created without the
first commit.

Use **Add Project** in the command palette (`Cmd/Ctrl+K`) to clone a repository. Choose a hosting
provider or paste a Git URL, then choose where to save it. The project opens right away while the
clone runs in the background: you can write your first prompt, and sending waits until the files
are in place. A toast tracks progress and lets you cancel; if the clone fails, retry it from the
toast or from the banner above the composer.

For a local Git repository without a remote, **Publish Repository** creates a hosted repository,
adds it as `origin`, and pushes your commits. If there are no commits yet, it creates the remote;
make your first commit before pushing.

## Create a pull request

Use a thread's Git actions to commit, push, and create a pull request. T3 Code can generate commit
messages, review titles, and descriptions from your changes.

Choose the writing style and model in **Settings → Source Control**. **Repository conventions**
uses the project's instructions and recent commit subjects.

## Review and merge

Open **Pull requests** to review changes and comments, request reviewers, check out a branch,
or merge. You can edit review titles and descriptions and your own comments where the host allows it.
GitLab calls these merge requests.

GitHub, GitLab, and Azure DevOps support auto-merge while checks are outstanding. GitHub also
supports approving waiting fork workflows and opening a revert pull request for a merged change.

GitHub sharing is off by default. In Settings → Connections → GitHub sharing (Environments on mobile), choose
**Read PRs** or **Read and act** for each environment you trust to share GitHub access.
Enable both the original environment and the environment answering its requests on this client.
**Read and act** can use broader GitHub permissions than the original environment's credential;
only enable it for environments you control and trust. Changing a saved endpoint or removing an
environment clears its permission.

GitHub review details, linked PR status, and permitted review actions can then use another
connected environment signed in to the same GitHub account. Each needs a project on that host.
A connected local environment is preferred for actions and can answer slow or failed reads.
Browsers and mobile clients need a paired environment to use its GitHub CLI credentials.
Credentials stay on their machines. Previously verified credentials remain usable for routing
for ten minutes during a GitHub outage; new credentials must be verified first. An action with
an uncertain result is never automatically retried elsewhere. Listings, diffs, and checkout or
PR creation from Git actions continue to use the project's environment.

For Azure DevOps, use the host website to change comments. Bitbucket does not support reopening a
declined pull request.

### Mark files as viewed

Tick a file off in the **Code** tab once you have read it and it collapses; the toolbar keeps a
running count. A tick belongs to the pull request rather than to a commit, so scoping the tab to a
single commit keeps them. A file pushed to after you cleared it comes back marked **Changed**.

On GitHub these are GitHub's own viewed marks, so a review carries between T3 Code and github.com
in either direction. Forgejo, GitLab, Bitbucket, and Azure DevOps expose no record T3 Code can read, so the
server you are connected to keeps them instead: they follow you across the apps connected to that
server, but the host's own site will not show them, and the count reads **viewed in T3 Code**.

The **Code** tab is a web and desktop surface. The mobile app reports a pull request's status but
does not show its diff, so marks are made and read on web and desktop.

## Troubleshooting

- **Not authenticated:** run the provider's login command on the server, then rescan. For Bitbucket,
  check the credentials saved in Settings → Source Control, or confirm the running server received
  the environment variables.
- **GitHub sign-in cannot be verified:** update GitHub CLI to at least 2.81.0.
- **Push fails despite a connected account:** check the Git remote's credentials. SSH and HTTPS
  remotes can require separate setup from the hosting provider's API access.
- **A review cannot load:** open it on the host website while resolving connectivity, permissions,
  or rate limits.

## Linked pull requests

A thread can hold several pull requests, including reviews from another repository on the same host.
Use **Link pull request** in the command palette or **Linked pull requests** panel, or right-click a
pull request link in the conversation. Creating a pull request from Git actions links it automatically.
Agents can link their pull requests with the `link_pull_request` tool.

Use **Link this PR** in a branch-detected badge's tooltip to keep it with the thread. From a review
on the Pull Requests page, **Link to thread** lets you search for an active thread. The review header
also lists the threads that link to it, including archived threads, so you can return to their context.

Thread badges show a stack's layer count or the current review number with a count of additional
links. Clicking a badge with more than one review opens the **Linked pull requests** panel. On mobile, the Git overview lists linked reviews and their stacks; tap a review to open it.
Linking and unlinking are available in the web and desktop clients.

The **Linked pull requests** panel lists every review and groups stacks. Unlink a review from its
row menu. An unlinked stack layer stays out of later syncs. Open linked reviews refresh on the server;
closed reviews refresh periodically so reopening one on the host is detected. Merged reviews refresh
when requested. With **Auto-settle merged threads** enabled, a thread can settle after every linked
review is terminal. An open or unsynced link keeps it active.

Linked reviews use matching repositories declared in the thread's checkout, so a workspace containing
several repositories does not need a separate T3 project for each one. Other cross-repository links
use a registered project on the same host. Azure DevOps reviews require a checkout from the matching
organization and repository. Older remote servers may require registering the child repository as a
project until the server is updated.

## GitHub stacks

The Pull Requests page shows each PR's position in its GitHub stack. Open the stack badge in a
review to navigate its layers. **Merge stack** submits the selected pull request and every unmerged
layer below it to GitHub together, respecting branch rules and merge queues. The confirmation shows
the scope and merge strategy. GitHub rebases the remaining stack after merging.

**Rebase stack** updates remote branches from bottom to top without changing your local checkout.
It can rewrite history and restart checks. If a layer fails, earlier updates remain; resolve that
layer before retrying. GitHub may require manual conflict resolution after a lower layer is amended,
even when its changes look independent. Stack actions require an environment that supports them.
