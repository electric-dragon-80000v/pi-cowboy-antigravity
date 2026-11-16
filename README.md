# pi-cowboy-antigravity

An [Antigravity CLI](https://antigravity.google) (`agy`) harness for
[pi-cowboy](https://github.com/electric-dragon-80000v/pi-cowboy). It runs each
pi-cowboy spawn as its own `agy` process in a herdr pane inside the spawn's
worktree, with the spawned agent's instructions as that process's entire
instruction set.

```bash
pnpm add -g agy            # or install the Antigravity CLI however you prefer
pi install ~/dev/pi-cowboy-antigravity
```

Once installed the harness appears as `antigravity` in `agent.harnessType`
settings and the spawn UI, under the label **Antigravity CLI**.

## How a spawn runs

The CLI has no prompt flag, so the instructions ride in as a custom agent
definition:

| Artifact         | Path                                                 | Written by                         |
| ---------------- | ---------------------------------------------------- | ---------------------------------- |
| Agent definition | `<staging>/.agents/agents/pi-cowboy-<subagentId>.md` | `prepare`                          |
| Session settings | `<staging>/agy-settings.json`                        | `prepare`                          |
| Task             | `<staging>/task.md`                                  | pi-cowboy                          |
| Result           | `<staging>/result.md`                                | the child, as its instructions say |

`<staging>` is the spawn's own `/tmp/pi-cowboy/<subagentId>/` directory, not the
worktree, so the checkout is never written and cleanup never races a dirty
check.

The launch is:

```bash
agy --settings <staging>/agy-settings.json \
    --add-dir <staging> \
    --agent pi-cowboy-<subagentId> \
    --dangerously-skip-permissions \
    [--model <slug>] [--effort <level>]
```

`--dangerously-skip-permissions` is what makes a background pane usable: without
it every file write and command waits for a keypress nobody is there to make.

### The definition is the whole instruction set

The staged definition carries `excludeDefaultComponents: true`. That flag drops
three things together: the CLI's own prompt sections, the workspace rules it
would inject from `GEMINI.md`, `AGENTS.md` and `.agents/rules/`, and the
built-in tool list. What is left is the definition's own body and its `tools:`
line, so a spawned agent sees only the prompt pi-cowboy compiled for it.

Because the flag takes the built-in tools away, `tools:` is always written. The
default set is:

```
read_file, edit_file, write_file, run_command, search_web
```

Two families are deliberately absent. The subagent family (`invoke_subagent`,
`manage_subagents`, `define_subagent`, `send_message`, `swarm`, `run_workflow`)
would run agents pi-cowboy does not supervise, and `ask_question` would park a
background pane on a question nobody is there to answer. The CLI keeps
`manage_task` whatever the definition says.

Two limits follow from suppression being of _injection_ only. A child with
`read_file` or `run_command` can still read a `GEMINI.md` on request, and rules
that some other mechanism drops into the context (a global
`~/.gemini/antigravity-cli/` rules file) are not removed by this flag.

## Non-interactive trust

The first launch in a directory the user has never trusted parks at
`Do you trust the contents of this project?`, and the CLI has no flag that
skips it. What does skip it is the session-scoped settings object:

```json
{ "trustedWorkspaces": ["/private/tmp/pi-cowboy/abc12345"] }
```

`--settings` applies it to that one process, so the user's own
`~/.gemini/antigravity-cli/settings.json` is untouched and the trust is never
remembered — every spawn states its own trust, every time.

The path must be the **canonical** one. The CLI compares the workspace it opens
(a resolved path) against these entries, so an unresolved `/tmp/...` entry is a
directory it has not been told about and the dialog appears as if the setting
were missing. `prepare` is the only hook that sees the spawn's `cwd`, so it
resolves the path there and writes the file; `buildArgs` only names it, which
keeps the argv a pure function of the launch inputs.

## Behaviour, member by member

- **availability** — `agy` on `PATH`. Missing, the harness reports itself
  unavailable with a notice and a template naming it falls back to `pi`.
- **prepare** — stages the definition and settings, then proves the pane reads
  both: the pane's own shell tests the three files and `command -v agy`, and
  echoes `AGY_STAGED`. A pane that never proves it stops the spawn with the
  reason instead of launching a CLI with no instructions.
- **postStart** — waits for the TUI's composer hint (`? for shortcuts`) and
  submits `Read the task in "<taskFile>" …` through the agent surface. A
  multiplexer without that surface, or a refused submit, fails the spawn rather
  than typing into an unverified pane.
- **steer** — the same agent surface, so a mid-run message arrives as a normal
  turn. Without the surface the steer reports `not-submitted`.
- **stop** — `ctrl+c` twice. The TUI interrupts on the first and exits on the
  second.
- **teardown** — removes the staged definition and settings, then the staging
  directories that are now empty. Safe when nothing was staged (a spawn that
  failed before `prepare`, or a recovered run).
- **listModels** — runs `agy models` through the extension's exec and parses
  the `slug<TAB>label` rows. Entries advertise no thinking control: the level
  is part of the model's own slug (see above). A catalog from a
  different major version than the `1.x` this plugin was written for is still
  offered, marked `fallback` with a notice. An unreadable catalog is
  `unavailable` with the CLI's own message.
- **readHandoverRecords** — reads the run's own transcript and classifies every
  entry: `USER_INPUT` → `user`, `PLANNER_RESPONSE` → `thinking`/`assistant`/
  `tool-call`, `GENERIC` (a tool's output) → `tool-call`, anything else →
  `other` with the native type as `unmappedKind`.

## Model names

pi-cowboy stores `provider/model` keys; `agy --model` wants the bare slug, so the
provider half is dropped at that boundary (`google/gemini-3.8-flash-medium` →
`gemini-3.8-flash-medium`). Bare keys pass through unchanged.

Thinking levels are **not** handed to `--effort`. In the interactive mode this
harness launches, the flag on its own does nothing at all (the model keeps its
own effort), and `--model` beside it makes the CLI drop the whole selection and
fall back to the model pinned in the user's settings — a run asked for
`claude-sonnet-4-6` at `high` came up on Gemini Flash. An `effort` key in the
settings object is worse: the CLI exits on it.

A model's effort is part of its slug (`gemini-3.8-flash-low`, `…-high`), so the
level is chosen by choosing the model, and the catalog advertises no thinking
control for any model. A requested thinking level is therefore dropped rather
than allowed to break the launch.

## Handover

The CLI's store is durable and global (`~/.gemini/antigravity-cli/`), with one
conversation per launch. There is no launch-time id to pin, so the reader uses
the evidence the run itself carries: this spawn's id is written into the
definition (`agent_name` in the store's own summary) and the task path is in the
first user turn, so a conversation whose first user turn contains either is this
run's. The newest such conversation wins, which is what a restarted run needs.
No conversation answering — or no store at all — refuses with the reason rather
than handing over somebody else's conversation.

Records come from `brain/<id>/.system_generated/logs/transcript_full.jsonl`,
which keeps model reasoning and tool calls that the conversation database does
not. A half-written last line is dropped; a line that does not parse is kept as
`unparseable`, so loss is reported rather than misread.

## What this plugin does not do

The `agy` CLI offers no way to relocate its config store; its whole state is
`~/.gemini/antigravity-cli/`. So this harness declares no `inheritedEnv` (there
is no name whose override would desync the parent's reading from the child's
writing) and no `reservedEnvVars` of its own. It also registers no config codec:
a plugin's `harness.antigravity` section reaches `prepare` but never the argv,
so nothing it could parse would change how the CLI launches.

## Development

```bash
pnpm install
pnpm test          # node --test
pnpm run syntax:check
pnpm run format:check
```

## Releasing

Versions are cut by [semantic-release](https://semantic-release.gitbook.io/)
from Conventional Commits on `main`. The `commit-msg` hook runs commitlint, so a
message the release cannot parse never gets recorded, and a `feat:` or `fix:` on
`main` is enough to release — there is no version to edit by hand.

`.github/workflows/publish.yml` runs after CI accepts a push to `main`, and then
semantic-release bumps `package.json`, writes `CHANGELOG.md`, commits the
release, pushes its tag, opens the GitHub release and **stages** the version on
npm. Staging is not publishing: a maintainer approves the staged version with
2FA — `pnpm run release:approve` (`npm stage approve`) or the Staged Packages
tab on npmjs.com — so a version never reaches installers on its own.

```bash
pnpm run release        # cut a release locally (needs push access and a token)
pnpm run release:stage  # re-stage the current version from a tag's checkout
pnpm run release:approve
```

Staging uses npm's trusted publishing through GitHub OIDC, so no `NPM_TOKEN` is
stored. Two things have to exist outside the repository: a trusted publisher for
`pi-cowboy-antigravity` on npmjs.com configured against `publish.yml` (no
environment), and a `RELEASE_TOKEN` secret for the account that may push to
`main` past its ruleset.
