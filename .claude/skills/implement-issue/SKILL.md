---
name: implement-issue
description: Implement a GitHub issue autonomously in a devcontainer
disable-model-invocation: true
argument-hint: <issue-number-or-url>
---

# Implement GitHub Issue in DevContainer

Implement the GitHub issue `$ARGUMENTS` by launching an autonomous Claude Code agent inside the devcontainer.

## Step 1: Create a feature branch

```bash
git checkout main && git pull
git checkout -b feat/issue-<number>-<short-description>
```

Use the issue number and a short kebab-case description derived from the issue title.

## Step 2: Start the devcontainer

Ensure Docker is running. This project uses Colima (native aarch64/vz by default on Apple Silicon):

```bash
colima status 2>/dev/null || colima start --cpu 8 --memory 16
```

Note: default `--arch aarch64` and `--vm-type vz` run native on Apple Silicon (no Rosetta).
Default disk is 100 GB which is sufficient.

If `devcontainer` CLI is not installed, install it first:
```bash
npm install -g @devcontainers/cli
```

Then start the devcontainer:

```bash
devcontainer up --workspace-folder .
```

Wait for the container to finish building and the `postStartCommand` to complete (database setup).

## Step 3: Check Claude Code authentication

`devcontainer exec` runs as the `vscode` user (set by `remoteUser` in devcontainer.json).
Claude Code must be authenticated **as this user** — authenticating as root will not work.

First check auth status:

```bash
devcontainer exec --workspace-folder . claude auth status
```

If authenticated, verify with a quick test:

```bash
devcontainer exec --workspace-folder . claude -p "Say hello"
```

If not authenticated, the user must log in interactively. Tell the user to open a terminal
and run:

```bash
docker exec -it -u vscode $(docker ps -q --filter label=devcontainer.local_folder=$(pwd)) bash -l
claude
```

Inside the interactive Claude session, type `/login` to complete the OAuth flow.
After authenticating, type `/exit` and then `exit` to leave the container shell.

**Important:** Do not proceed to Step 4 until authentication is confirmed working.

## Step 4: Launch autonomous implementation

Run Claude Code inside the devcontainer with skip-permissions to implement the issue:

```bash
devcontainer exec --workspace-folder . claude --dangerously-skip-permissions \
  -p "Implement GitHub issue $ARGUMENTS.

Read the issue with: gh issue view $ARGUMENTS
Read CLAUDE.md and .github/copilot-instructions.md for project conventions.
Read existing code before modifying it - understand patterns first.

Implement the issue following existing code patterns.
Do not create unnecessary files.
Do not add features beyond what the issue asks for.

Verify with: cd nt-be && cargo build && cargo test
Fix any build or test failures before proceeding.

When done, commit with a message referencing the issue:
  feat: <description>
  Closes #<issue-number>
"
```

## Step 5: Monitor progress

The workspace is mounted from the host, so file changes are visible on both sides.
Monitor progress from the host:

```bash
# Check for file changes
git diff --stat

# Check session activity inside the container (line count grows as agent works)
docker exec $(docker ps -q --filter label=devcontainer.local_folder=$(pwd)) \
  bash -c "wc -l /home/vscode/.claude/projects/-workspaces-treasury26/*.jsonl | tail -5"
```

## Step 6: Report result

After Claude Code finishes, check the commits from the host:

```bash
git log --oneline -5
```

Push the branch and create a draft PR from the host (gh is not authenticated in the container):

```bash
git push -u origin <branch-name>
gh pr create --draft --title "<short title>" --body "Closes #<issue-number>"
```

Report the PR URL to the user.
