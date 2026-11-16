/**
 * plugin.js — the Antigravity CLI (`agy`) harness for pi-cowboy.
 *
 * The CLI has no prompt flag and no way to relocate its config root, so a
 * spawn's instructions reach it as a custom agent definition discovered from a
 * directory the launch adds: `prepare` writes
 * `<staging>/.agents/agents/pi-cowboy-<id>.md` and `buildArgs` points the CLI
 * at that directory with `--add-dir`, naming the definition with `--agent`.
 * The same definition carries `excludeDefaultComponents: true`, which is what
 * makes it the whole instruction set rather than an addition to the CLI's own:
 * the flag drops the default prompt sections, the workspace rules
 * (`GEMINI.md`/`AGENTS.md`, `.agents/rules/`) and the built-in tool list
 * together, so the `tools:` line beside it is the run's entire tool set.
 *
 * Two consequences shape the rest of this file. The staging tree is the one
 * artifact, and it sits in the spawn's own `/tmp/pi-cowboy/<id>/` directory
 * rather than the worktree, so the checkout is never written and cleanup does
 * not have to run before a dirty probe. And because the flag removes the
 * built-in tools, `tools:` is never optional — a definition without it leaves
 * the child with `manage_task` alone.
 *
 * The launch is the CLI's own interactive TUI, so herdr detects the process as
 * `agy` and the agent surface carries the task and the steer: `postStart` waits
 * for the composer and then submits `taskPrompt`. Nothing is typed into the
 * pane shell, so there is no launcher to install and no shell function to
 * verify.
 *
 * Attended start and unattended start differ by one setting. The first launch
 * in a directory the user has never trusted parks at
 * `Do you trust the contents of this project?`, and no flag skips it: the
 * session-scoped `--settings` object does, through `trustedWorkspaces`, and it
 * is never persisted. The path there has to be the canonical one
 * (`/private/tmp/...` on macOS, not `/tmp/...`), which is why `prepare` — the
 * only hook that sees `cwd` — resolves it and writes the object, while
 * `buildArgs` merely names the file. A settings file is also the only route
 * that keeps the argv a pure function of the launch inputs.
 */

import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

/** Echoed by the pane once the launch's staged state is readable from it. */
const stagedMarker = "AGY_STAGED";

/** The TUI's composer hint, on screen only once the composer accepts input. */
const composerHint = "? for shortcuts";

/**
 * The levels `--effort` names. The flag exists, and print mode validates it, so
 * the vocabulary is the CLI's; the interactive launch this harness starts is
 * where it does nothing (see `buildArgs`).
 */
export const thinkingLevels = ["low", "medium", "high", "xhigh", "max"];

/** Where the CLI discovers a custom agent inside a directory it was given. */
const agentDirectory = join(".agents", "agents");

/** The session settings file the launch points `--settings` at. */
const settingsFileName = "agy-settings.json";

/**
 * The tools a run gets when nothing narrows the set. `excludeDefaultComponents`
 * takes the CLI's own list away, so this list is not a filter over it: it is
 * everything the child can call, besides `manage_task`, which the CLI keeps
 * whatever the definition says. It is the file, command and web half of the
 * CLI's vocabulary. Two families are left out: the subagent one
 * (`invoke_subagent`, `swarm`, `run_workflow`) because those run agents
 * pi-cowboy does not supervise, and `ask_question` because the pane has nobody
 * to answer it — a worker that asks parks until it is killed.
 */
export const defaultTools = [
  "read_file",
  "edit_file",
  "write_file",
  "run_command",
  "search_web",
];

/**
 * pi's tool names as the CLI's own. A template writes pi's vocabulary
 * (`read`, `bash`, …) and the definition needs the CLI's, so the names that
 * have a counterpart are translated here. A name with no counterpart is
 * written through unchanged: the CLI ignores what it does not know, and a name
 * that is already the CLI's own then works as written.
 */
const toolNameMap = new Map([
  ["read", "read_file"],
  ["read_file", "read_file"],
  ["write", "write_file"],
  ["write_file", "write_file"],
  ["edit", "edit_file"],
  ["edit_file", "edit_file"],
  ["multi_edit", "edit_file"],
  ["bash", "run_command"],
  ["shell", "run_command"],
  ["run_command", "run_command"],
  ["web_fetch", "search_web"],
  ["web_search", "search_web"],
  ["search_web", "search_web"],
  ["ask", "ask_question"],
  ["ask_question", "ask_question"],
]);

/** The CLI's name for one tool, or the name as written when it has none. */
export function toolName(name) {
  return toolNameMap.get(name) ?? name;
}

/**
 * The `tools:` list one launch stages, from the selection the spawn resolved.
 *
 * `default` is the harness's own list rather than the CLI's, because the
 * definition excludes the components that would otherwise supply one. `none`
 * is an empty list, which leaves the child the `manage_task` the CLI always
 * keeps. `exclude` is the harness's list minus the excluded names, since the
 * selection's vocabulary is pi's and there is no CLI list left to subtract
 * from.
 */
export function stagedToolNames(selection) {
  switch (selection.kind) {
    case "default":
      return [...defaultTools];
    case "none":
      return [];
    case "include":
      return uniqueNames(selection.names.map(toolName));
    case "exclude": {
      const excluded = new Set(selection.names.map(toolName));
      return defaultTools.filter((name) => !excluded.has(name));
    }
  }
}

/** The names in the order they were written, first occurrence kept. */
function uniqueNames(names) {
  return [...new Set(names)];
}

/** The agent name one spawn's definition answers to. */
export function agentName(subagentId) {
  return `pi-cowboy-${subagentId}`;
}

/** The spawn's staging directory, as every staged file's plain sibling. */
export function stagingDirectoryOf(launch) {
  return dirname(launch.systemPromptFile);
}

/**
 * The staging directory one spawn id always has, derived rather than received:
 * pi-cowboy stages every spawn's prompt, task and result under
 * `<tmpdir>/pi-cowboy/<subagentId>`, so a teardown in a process that never ran
 * `prepare` (a session reloaded mid-run) still knows where to look.
 */
export function stagingDirectoryFor(subagentId) {
  return join(tmpdir(), "pi-cowboy", subagentId);
}

/** The staged definition the launch names with `--agent`. */
export function agentFileOf(launch) {
  return join(
    stagingDirectoryOf(launch),
    agentDirectory,
    `${agentName(launch.subagentId)}.md`,
  );
}

/** The session settings file the launch names with `--settings`. */
export function settingsFileOf(launch) {
  return join(stagingDirectoryOf(launch), settingsFileName);
}

/**
 * One spawn's agent definition: the frontmatter that makes it the whole
 * instruction set, then the compiled system prompt as its body.
 *
 * `tools:` is written inline (flow style) because the CLI reads this
 * frontmatter with its own parser, and the flow form is the one a real launch
 * was verified to honour. An empty selection is written as `[]` rather than
 * omitted, so the definition never falls back to a list it did not mean.
 */
export function agentDefinition({ subagentId, tools, systemPrompt }) {
  const body = systemPrompt.replace(/\s+$/, "");
  return [
    "---",
    `name: ${agentName(subagentId)}`,
    `description: pi-cowboy subagent ${subagentId}.`,
    "excludeDefaultComponents: true",
    `tools: [${tools.join(", ")}]`,
    "---",
    "",
    body === "" ? "" : `${body}\n`,
  ].join("\n");
}

/**
 * The session settings the launch points at. `trustedWorkspaces` is the whole
 * object: it clears the trust gate for the one directory the spawn runs in,
 * and `--settings` keeps it to that process, so nothing about the user's own
 * settings changes.
 *
 * The path is resolved first. The CLI compares the workspace it opens (a
 * resolved path, `/private/tmp/...` on macOS) against these entries, so an
 * unresolved `/tmp/...` entry is a directory it has not been told about and the
 * trust dialog appears exactly as if the setting were missing.
 */
export function settingsBody(cwd) {
  return `${JSON.stringify({ trustedWorkspaces: [canonicalPath(cwd)] }, null, 2)}\n`;
}

/** A path as the filesystem spells it, or as given when it does not resolve. */
export function canonicalPath(value) {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * The message that makes a spawn read its task. The spawn id opens it because
 * this is the one place the CLI's durable transcript records the id at all:
 * the conversation is matched back to the spawn from this first turn, so the
 * reader works in a process that never ran `prepare` as well as one that did.
 * The path is JSON-quoted so the agent sees an unambiguous path, and the
 * sentence names the result file, which is this harness's settlement signal.
 */
export function taskPrompt(taskFile, subagentId) {
  return `This pi-cowboy spawn is ${subagentId}. Read the task in ${JSON.stringify(taskFile)} with read_file and carry it out, following your pi-cowboy instructions. Write the result file your instructions name before you finish, and never commit temporary pi-cowboy files.`;
}

/** `agy models` rows as a model list. The progress line carries no tab. */
export function parseModels(output) {
  const entries = [];
  const seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    const cut = line.indexOf("\t");
    if (cut <= 0) continue;
    const key = line.slice(0, cut).trim();
    const label = line.slice(cut + 1).trim();
    if (key === "" || /\s/.test(key) || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      key,
      label: label === "" ? key : label,
      // An empty closed list is "this model has no thinking control", and the
      // interactive launch offers none: the level is part of the model's own
      // slug (`…-low`, `…-high`), picked by choosing that model.
      thinkingLevels: { kind: "closed", levels: [] },
    });
  }
  return entries;
}

/**
 * The model name the CLI's `--model` takes: a bare slug, never the
 * `provider/model` shape every pi-cowboy layer stores. The provider half is
 * dropped at this boundary — `google/gemini-3.8-flash-medium` is refused by the
 * CLI, `gemini-3.8-flash-medium` is what it lists.
 */

export function modelName(modelKey) {
  const cut = modelKey.lastIndexOf("/");
  return cut === -1 ? modelKey : modelKey.slice(cut + 1);
}

/** The root of the CLI's durable store. Only `HOME` moves it. */
export function storeRoot(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".gemini", "antigravity-cli");
}

/** The directory holding one entry per conversation. */
export function brainRoot(env = process.env) {
  return join(storeRoot(env), "brain");
}

/** One conversation's full transcript, which carries thinking and tool calls. */
export function transcriptPath(conversationDir) {
  return join(
    conversationDir,
    ".system_generated",
    "logs",
    "transcript_full.jsonl",
  );
}

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A parsed entry with no canonical kind, named by the native type that
 * distinguishes it. A type the store left empty, or wrote as a non-string, is
 * named `unknown`, so `unmappedKind` always says what to look for.
 */
function otherRecord(unmappedKind, content) {
  return {
    kind: "other",
    unmappedKind:
      typeof unmappedKind === "string" && unmappedKind !== ""
        ? unmappedKind
        : "unknown",
    content,
  };
}

/** Consistent newlines, no trailing whitespace, no blank margin. */
function normalizeText(text) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

/**
 * A user turn's own words. The CLI wraps what was typed in `<USER_REQUEST>`
 * and appends blocks of its own (the clock, a settings change); the wrapper's
 * content is the turn, and a store that wrote no wrapper is read with its
 * metadata blocks removed so the record carries prose rather than envelope.
 */
export function userProse(content) {
  const wrapped = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(content);
  if (wrapped) return normalizeText(wrapped[1]);
  return normalizeText(content.replace(/<([A-Z_]+)>[\s\S]*?<\/\1>/g, ""));
}

/**
 * One transcript file as its entries, validated at the top: a line the CLI has
 * not finished appending is not a complete entry and is dropped, and a line
 * that does not parse is kept as `null` so the reader reports it as loss rather
 * than misreading the file.
 */
export function parseTranscript(file) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  // A file being appended to ends mid-line; that fragment is not an entry yet.
  if (!content.endsWith("\n")) lines.pop();

  const entries = [];
  for (const raw of lines) {
    if (raw.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
    entries.push({ raw, value });
  }
  return entries;
}

/** The prose of a transcript's first user turn, or undefined when it has none. */
function firstUserInput(entries) {
  for (const { value } of entries) {
    if (!isRecord(value) || value.type !== "USER_INPUT") continue;
    if (typeof value.content !== "string") continue;
    return userProse(value.content);
  }
  return undefined;
}

/**
 * The conversation this run wrote.
 *
 * The store has no launch-time id to pin, so identity is evidence: this spawn's
 * id is written into the definition the run launches with (`agent_name` in the
 * store's own summary table) and into the task path the opening message names,
 * so a conversation whose first user turn carries either answers to this run.
 * The newest such conversation wins — a run that was restarted writes a second
 * one for the same spawn id, and the live one is the later of them. No
 * conversation answering, or the store missing entirely, refuses with the
 * reason rather than guessing at the newest conversation there is.
 */
export function findRunConversation({
  subagentId,
  taskFile,
  root = brainRoot(),
}) {
  let names;
  try {
    names = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `No Antigravity conversation store at ${root}: ${error.message}`,
    );
  }

  const candidates = [];
  for (const name of names.filter((entry) => entry.isDirectory())) {
    const file = transcriptPath(join(root, name.name));
    if (!existsSync(file)) continue;
    let entries;
    try {
      entries = parseTranscript(file);
    } catch {
      continue;
    }
    const opened = firstUserInput(entries);
    if (opened === undefined) continue;
    const answers =
      (subagentId !== "" && opened.includes(subagentId)) ||
      (typeof taskFile === "string" && opened.includes(taskFile));
    if (!answers) continue;
    let modified = 0;
    try {
      modified = statSync(file).mtimeMs;
    } catch {
      modified = 0;
    }
    candidates.push({ id: name.name, file, entries, modified });
  }

  if (candidates.length === 0) {
    throw new Error(
      `No Antigravity conversation under ${root} answers to spawn ${subagentId}.`,
    );
  }
  candidates.sort((a, b) => b.modified - a.modified);
  return candidates[0];
}

/**
 * One entry's records, in native order: the user's prose, the model's reasoning
 * then its prose then the calls it made, and a tool's own output as the call's
 * record. A `GENERIC` entry is what the CLI writes for a tool result — command
 * output, a file's contents — and it names no tool, so the record carries the
 * native entry whole rather than inventing an association.
 */
export function recordsFor(entry, raw) {
  if (entry.type === "USER_INPUT") {
    if (typeof entry.content !== "string") {
      return [{ kind: "unparseable", content: raw }];
    }
    return [{ kind: "user", content: userProse(entry.content) }];
  }

  if (entry.type === "PLANNER_RESPONSE") {
    const records = [];
    if (typeof entry.thinking === "string") {
      const thinking = normalizeText(entry.thinking);
      if (thinking !== "")
        records.push({ kind: "thinking", content: thinking });
    }
    if (typeof entry.content === "string") {
      const text = normalizeText(entry.content);
      if (text !== "") records.push({ kind: "assistant", content: text });
    }
    if (Array.isArray(entry.tool_calls) && entry.tool_calls.length > 0) {
      records.push({
        kind: "tool-call",
        content: JSON.stringify(entry.tool_calls),
      });
    }
    return records.length > 0
      ? records
      : [otherRecord("PLANNER_RESPONSE", raw)];
  }

  if (entry.type === "GENERIC") {
    return [
      {
        kind: "tool-call",
        content:
          typeof entry.content === "string"
            ? JSON.stringify({ type: "GENERIC", content: entry.content })
            : raw,
      },
    ];
  }

  if (entry.type === "ERROR_MESSAGE") {
    return [
      otherRecord(
        "ERROR_MESSAGE",
        typeof entry.error === "string" ? entry.error : raw,
      ),
    ];
  }

  return [otherRecord(entry.type, raw)];
}

/** Every complete entry after the header, classified as it is consumed. */
function* transcriptRecords(entries) {
  for (const { raw, value } of entries) {
    if (!isRecord(value)) {
      yield { kind: "unparseable", content: raw };
      continue;
    }
    yield* recordsFor(value, raw);
  }
}

/** One conversation as the handover record source pi-cowboy reads. */
export function sessionSource(conversation) {
  return {
    sessionId: conversation.id,
    records: transcriptRecords(conversation.entries),
  };
}

/**
 * The major version this plugin was written against. The flags its launch
 * passes and the transcript layout its reader parses are that release's; a
 * different major is reported to the human rather than refused, because the
 * catalog is still worth offering.
 */
const writtenForMajor = 1;

/** The major version in a `--version` answer, or undefined for anything else. */
function majorVersion(version) {
  const match = /^(\d+)\.\d+\.\d+/.exec(version.trim());
  return match ? Number(match[1]) : undefined;
}

/** Whether a program is executable from the `PATH` of the given environment. */
export function onPath(name, env = process.env) {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    try {
      accessSync(join(dir || ".", name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The harness's availability answer for one environment. It is a function of
 * `env` rather than of the ambient process so the answer can be proved against
 * a `PATH` a test owns: the machine running the tests need not have the CLI.
 */
export function availabilityOf(env = process.env) {
  return onPath("agy", env)
    ? { status: "available" }
    : { status: "unavailable", notice: "Antigravity requires agy on PATH." };
}

/** A value as one POSIX shell word. */
function singleQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The proof that the pane can see what prepare staged, read back by its shell. */
function stagedProof(launch) {
  const agentFile = agentFileOf(launch);
  return [
    `test -r ${singleQuote(agentFile)}`,
    `test -r ${singleQuote(launch.taskFile)}`,
    `test -r ${singleQuote(settingsFileOf(launch))}`,
    "command -v agy >/dev/null",
    // Broken with `""` so only the shell's evaluation produces the token, not
    // the echoed command line the output wait also sees.
    'echo AGY_""STAGED',
  ].join(" && ");
}

/**
 * Remove the files this harness staged and the directories it created for
 * them, keeping every directory that still holds something — pi-cowboy's own
 * prompt, task and result files live in the same tree and are not ours to
 * delete. A file that is already gone is not an error: teardown runs again
 * after a failure, and after a reload that staged nothing.
 */
function removeStaged(subagentId, stagingDir) {
  const agentDir = join(stagingDir, agentDirectory);
  for (const file of [
    join(agentDir, `${agentName(subagentId)}.md`),
    join(stagingDir, settingsFileName),
  ]) {
    rmSync(file, { force: true });
  }
  for (const directory of [agentDir, dirname(agentDir)]) {
    try {
      if (readdirSync(directory).length === 0) rmdirSync(directory);
    } catch {
      // Already gone, or not empty: either way there is nothing to prune.
    }
  }
}

export default function register(api) {
  /**
   * The directory each spawn staged into, keyed by spawn id: teardown names a
   * path its request does not carry, and a run that never prepared (or one
   * recovered after a reload) leaves nothing here to remove.
   */
  const stagedDirs = new Map();

  /** The CLI's own version, read once: it cannot change under a live session. */
  let version;
  const agyVersion = () => {
    version ??= api.pi
      .exec("agy", ["--version"], { timeout: 5000 })
      .then(({ code, stdout }) => {
        // An answer that is not a version tells the compatibility check
        // nothing, so it is not a mismatch either.
        const major = code === 0 ? majorVersion(stdout) : undefined;
        return major === undefined ? undefined : { raw: stdout.trim(), major };
      })
      .catch(() => undefined);
    return version;
  };

  api.registerHarness({
    id: "antigravity",
    displayName: "Antigravity CLI",
    agentMultiplexerKind: "agy",
    availability: () => availabilityOf(),
    /**
     * Stage the definition and the trust override, then prove the pane reads
     * both. The definition is what the launch names, so a pane that cannot see
     * it would start the CLI with no instructions and no way to notice; the
     * proof runs the pane's own shell, which need not share this process's
     * view of the filesystem.
     */
    prepare: async ({ pane, paneId, cwd, launch }) => {
      const agentFile = agentFileOf(launch);
      mkdirSync(dirname(agentFile), { recursive: true, mode: 0o700 });
      writeFileSync(
        agentFile,
        agentDefinition({
          subagentId: launch.subagentId,
          tools: stagedToolNames(launch.toolSelection),
          systemPrompt: readFileSync(launch.systemPromptFile, "utf8"),
        }),
        { mode: 0o600 },
      );
      writeFileSync(settingsFileOf(launch), settingsBody(cwd), { mode: 0o600 });
      stagedDirs.set(launch.subagentId, stagingDirectoryOf(launch));

      await pane.run(paneId, stagedProof(launch));
      try {
        await pane.waitForOutput(paneId, stagedMarker, 15_000);
      } catch {
        throw new Error(
          `failed to prepare the pane: the pane never proved it can see the staged Antigravity state — the agent definition ${agentFile}, the task ${launch.taskFile}, the settings ${settingsFileOf(launch)}, or the agy binary on its PATH. The agent did not start.`,
        );
      }
    },
    /**
     * Deliver the task as the first turn. Acceptance of the start is not
     * readiness — the TUI prints its composer hint only once the composer takes
     * input — so this waits for that hint and refuses rather than typing into
     * an unverified pane.
     */
    postStart: async ({ pane, paneId, launch, signal }) => {
      if (!pane.promptAgent) {
        throw new Error(
          "This multiplexer cannot submit a task into the Antigravity pane; the agent did not receive its task.",
        );
      }
      await pane.waitForOutput(paneId, composerHint, 60_000);
      signal.throwIfAborted();
      const outcome = await pane.promptAgent(
        paneId,
        taskPrompt(launch.taskFile, launch.subagentId),
      );
      if (outcome.kind !== "submitted") {
        throw new Error(
          `Antigravity did not accept the task: ${outcome.detail}`,
        );
      }
    },
    /**
     * The CLI's interactive launch. `--settings` names the file prepare wrote,
     * which is what keeps this argv a function of the launch inputs alone;
     * `--add-dir` and `--agent` are how the staged definition becomes the
     * instruction set; `--dangerously-skip-permissions` is the auto-approval a
     * background pane needs, and it does not lift the workspace boundary for
     * reads, only for the approvals that would otherwise stop the run.
     *
     * The launch carries no `--effort`, however a level was requested: in this
     * interactive mode the flag alone does nothing (the model's own effort
     * stays), and `--model` beside it makes the CLI drop the whole selection
     * and fall back to the model in the user's settings — so a run asked for
     * `claude-sonnet-4-6` at `high` started on Gemini Flash instead. A model's
     * effort is part of its slug (`gemini-3.8-flash-low`, `…-high`), which is
     * why the catalog advertises no thinking control and the level is chosen by
     * choosing the model.
     */
    buildArgs: (launch) => {
      const args = [
        "--settings",
        settingsFileOf(launch),
        "--add-dir",
        stagingDirectoryOf(launch),
        "--agent",
        agentName(launch.subagentId),
        "--dangerously-skip-permissions",
      ];
      const model =
        launch.modelKey === null ? null : modelName(launch.modelKey);
      if (model !== null) args.push("--model", model);
      return args;
    },
    /**
     * The TUI interrupts on the first ctrl+c and exits on the second, so the
     * pair is what ends the process; one press alone would leave it running.
     */
    stop: async ({ pane, paneId }) => {
      await pane.sendKeys(paneId, ["ctrl+c"]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await pane.sendKeys(paneId, ["ctrl+c"]);
    },
    /** The agent surface carries a steer exactly as it carries the task. */
    steer: async ({ pane, paneId, message }) => {
      if (!pane.promptAgent) {
        return {
          kind: "not-submitted",
          detail: "This multiplexer offers no agent surface for Antigravity.",
        };
      }
      return pane.promptAgent(paneId, message);
    },
    /**
     * The conversation's records, read from the store the CLI writes. The run
     * is the one this spawn's own definition and task path answer to (see
     * findRunConversation); the task file comes from the request, so the read
     * does not depend on this process having launched the spawn.
     */
    readHandoverRecords: async ({ subagentId, staged }) => {
      const conversation = findRunConversation({
        subagentId,
        taskFile: staged.taskFile,
      });
      return sessionSource(conversation);
    },
    /** Remove the staged definition and trust override; the tree is pi-cowboy's. */
    teardown: async ({ subagentId }) => {
      const stagingDir = stagedDirs.get(subagentId);
      stagedDirs.delete(subagentId);
      removeStaged(
        subagentId,
        stagingDir === undefined ? stagingDirectoryFor(subagentId) : stagingDir,
      );
    },
    /**
     * The CLI's own catalog, read through the extension's exec so the TUI never
     * blocks on it. A catalog that cannot be read is an unavailable list rather
     * than a throw; a catalog from another major is still offered, with the
     * line that says the launch and the transcript reader were written for
     * this one.
     */
    listModels: async () => {
      try {
        const { code, stdout, stderr } = await api.pi.exec("agy", ["models"], {
          timeout: 15_000,
        });
        if (code !== 0) {
          const reason = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
          throw new Error(`\`agy models\` exited ${code}${reason}`);
        }
        const entries = parseModels(stdout);
        if (entries.length === 0) {
          return {
            kind: "unavailable",
            notice: "Antigravity returned no models.",
          };
        }
        const reported = await agyVersion();
        if (reported !== undefined && reported.major !== writtenForMajor) {
          return {
            kind: "fallback",
            entries,
            notice: `Antigravity ${reported.raw} is not a ${writtenForMajor}.x release, the major version this plugin was written for; spawning and model selection may not work.`,
          };
        }
        return { kind: "listed", entries };
      } catch (error) {
        return {
          kind: "unavailable",
          notice: `Could not list Antigravity models: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
