import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import register, {
  agentDefinition,
  agentFileOf,
  availabilityOf,
  brainRoot,
  canonicalPath,
  defaultTools,
  findRunConversation,
  modelName,
  parseModels,
  parseTranscript,
  recordsFor,
  sessionSource,
  settingsBody,
  settingsFileOf,
  stagedToolNames,
  stagingDirectoryFor,
  thinkingLevels,
  toolName,
  transcriptPath,
  userProse,
} from "./plugin.js";

const launch = (overrides = {}) => ({
  subagentId: "abc12345",
  systemPromptFile: "/tmp/pi-cowboy/abc12345/system.md",
  taskFile: "/tmp/pi-cowboy/abc12345/task.md",
  resultFile: "/tmp/pi-cowboy/abc12345/result.md",
  modelKey: null,
  thinking: null,
  toolSelection: { kind: "default" },
  envFile: null,
  ...overrides,
});

/** A registered harness from a fake api, with the exec answers it was given. */
function harnessFrom({ exec } = {}) {
  let registered;
  const calls = [];
  const api = {
    cwd: "/project",
    pi: {
      exec: async (command, args, options) => {
        calls.push({ command, args, options });
        return exec
          ? exec(command, args, options)
          : { code: 0, stdout: "", stderr: "" };
      },
    },
    registerHarness: (harness) => {
      registered = harness;
      return true;
    },
    registerMultiplexer: () => true,
  };
  const dispose = register(api);
  assert.equal(dispose, undefined);
  return { harness: registered, calls };
}

const silentPane = (overrides = {}) => ({
  kind: "herdr",
  run: async () => {},
  sendKeys: async () => {},
  waitForOutput: async () => {},
  ...overrides,
});

/** A staging tree for one launch, inside a fresh temporary directory. */
function stagedLaunch(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "agy-plugin-"));
  const staging = join(root, "abc12345");
  mkdirSync(staging, { recursive: true });
  const systemPrompt = join(staging, "system.md");
  writeFileSync(systemPrompt, "You are a worker.\n\nWrite the result file.\n");
  const taskFile = join(staging, "task.md");
  writeFileSync(taskFile, "Do the thing.\n");
  return {
    root,
    systemPromptFile: systemPrompt,
    launch: launch({ systemPromptFile: systemPrompt, taskFile, ...overrides }),
  };
}

/* ── the staged definition ──────────────────────────────────────────────── */

test("agentDefinition stages the whole instruction set as one definition", () => {
  const definition = agentDefinition({
    subagentId: "abc12345",
    tools: ["read_file", "run_command"],
    systemPrompt: "You are a worker.\nWrite the result.\n\n",
  });
  const [open, name, description, exclude, tools, close, blank, ...body] =
    definition.split("\n");
  assert.equal(open, "---");
  assert.equal(name, "name: pi-cowboy-abc12345");
  assert.match(description, /^description: /);
  assert.equal(exclude, "excludeDefaultComponents: true");
  assert.equal(tools, "tools: [read_file, run_command]");
  assert.equal(close, "---");
  assert.equal(blank, "");
  assert.equal(body.join("\n"), "You are a worker.\nWrite the result.\n");
});

test("agentDefinition writes an empty selection as an empty list", () => {
  const definition = agentDefinition({
    subagentId: "abc12345",
    tools: [],
    systemPrompt: "",
  });
  assert.match(definition, /^tools: \[\]$/m);
});

/* ── tool selection ─────────────────────────────────────────────────────── */

test("stagedToolNames maps every arm of the selection to a concrete list", () => {
  assert.deepEqual(stagedToolNames({ kind: "default" }), defaultTools);
  assert.deepEqual(stagedToolNames({ kind: "none" }), []);
  assert.deepEqual(
    stagedToolNames({ kind: "include", names: ["read", "bash"] }),
    ["read_file", "run_command"],
  );
  assert.deepEqual(
    stagedToolNames({ kind: "exclude", names: ["bash"] }),
    defaultTools.filter((name) => name !== "run_command"),
  );
});

test("stagedToolNames keeps the written order and drops repeats", () => {
  assert.deepEqual(
    stagedToolNames({ kind: "include", names: ["bash", "read", "shell"] }),
    ["run_command", "read_file"],
  );
});

test("toolName translates pi's names and passes the CLI's through", () => {
  assert.equal(toolName("multi_edit"), "edit_file");
  assert.equal(toolName("web_fetch"), "search_web");
  assert.equal(toolName("run_command"), "run_command");
  assert.equal(toolName("something_else"), "something_else");
});

/* ── the launch argv ────────────────────────────────────────────────────── */

test("buildArgs names the staged settings, directory and agent", () => {
  const { harness } = harnessFrom();
  const args = harness.buildArgs(launch());
  assert.deepEqual(args, [
    "--settings",
    "/tmp/pi-cowboy/abc12345/agy-settings.json",
    "--add-dir",
    "/tmp/pi-cowboy/abc12345",
    "--agent",
    "pi-cowboy-abc12345",
    "--dangerously-skip-permissions",
  ]);
});

test("buildArgs carries the model only when it was requested", () => {
  const { harness } = harnessFrom();
  const args = harness.buildArgs(
    launch({ modelKey: "google/gemini-3.8-flash-medium", thinking: "high" }),
  );
  assert.deepEqual(args.slice(-2), ["--model", "gemini-3.8-flash-medium"]);
});

test("buildArgs never sends --effort, which discards the model in the TUI", () => {
  const { harness } = harnessFrom();
  for (const thinking of ["high", "max"]) {
    const args = harness.buildArgs(
      launch({ modelKey: "google/gemini-3.8-flash-medium", thinking }),
    );
    assert.equal(args.includes("--effort"), false);
  }
  // A level with no model override is dropped too: the flag alone does nothing.
  const bare = harness.buildArgs(launch({ thinking: "max" }));
  assert.equal(bare.includes("--effort"), false);
  assert.deepEqual(bare.slice(0, 2), [
    "--settings",
    "/tmp/pi-cowboy/abc12345/agy-settings.json",
  ]);
});

test("modelName drops the provider half the CLI refuses", () => {
  assert.equal(
    modelName("google/gemini-3.8-flash-medium"),
    "gemini-3.8-flash-medium",
  );
  assert.equal(modelName("gemini-3.8-flash-medium"), "gemini-3.8-flash-medium");
});

/* ── the trust override ─────────────────────────────────────────────────── */

test("settingsBody trusts the canonical path the TUI actually opens", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-trust-"));
  const real = join(root, "real");
  mkdirSync(real);
  const alias = join(root, "alias");
  symlinkSync(real, alias);

  const parsed = JSON.parse(settingsBody(alias));
  assert.deepEqual(parsed, { trustedWorkspaces: [canonicalPath(alias)] });
  assert.equal(canonicalPath(alias), canonicalPath(real));
});

test("settingsBody keeps the path when it cannot be resolved", () => {
  const missing = join(tmpdir(), "agy-does-not-exist-xyz", "work");
  assert.deepEqual(JSON.parse(settingsBody(missing)), {
    trustedWorkspaces: [missing],
  });
});

/* ── the model catalog ──────────────────────────────────────────────────── */

test("parseModels reads the rows and drops the progress line", () => {
  const entries = parseModels(
    [
      "Fetching available models...",
      "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
      "gemini-3.8-pro\tGemini 3.8 Pro",
      "gemini-3.8-pro\tDuplicate",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    entries.map((entry) => entry.key),
    ["gemini-3.8-flash-medium", "gemini-3.8-pro"],
  );
  assert.equal(entries[0].label, "Gemini 3.8 Flash (Medium)");
  // The interactive launch has no thinking control; the level is the model's.
  assert.deepEqual(entries[0].thinkingLevels, { kind: "closed", levels: [] });
  assert.deepEqual(thinkingLevels, ["low", "medium", "high", "xhigh", "max"]);
});

test("parseModels falls back to the slug when a row has no label", () => {
  assert.equal(parseModels("some-model\t\n")[0].label, "some-model");
});

test("parseModels keeps model keys as the CLI lists them", () => {
  const entries = parseModels("gemini-3.8-flash-medium\tGemini 3.8 Flash\n");
  assert.equal(entries[0].key, "gemini-3.8-flash-medium");
  assert.equal(entries[0].key.includes("/"), false);
});

/* ── the transcript reader ──────────────────────────────────────────────── */

test("userProse unwraps the request and drops the CLI's own blocks", () => {
  assert.equal(
    userProse(
      "<USER_REQUEST>Read the task in &quot;x&quot;</USER_REQUEST>\n<ADDITIONAL_METADATA>today</ADDITIONAL_METADATA>",
    ),
    "Read the task in &quot;x&quot;",
  );
  assert.equal(
    userProse("bare words\n<USER_SETTINGS_CHANGE>{}</USER_SETTINGS_CHANGE>"),
    "bare words",
  );
});

test("recordsFor classifies the model's turn in native order", () => {
  const records = recordsFor(
    {
      type: "PLANNER_RESPONSE",
      thinking: "  weighing options \n",
      content: "Here is the plan.",
      tool_calls: [{ name: "read_file", args: { path: "a" } }],
    },
    "raw",
  );
  assert.deepEqual(
    records.map((record) => record.kind),
    ["thinking", "assistant", "tool-call"],
  );
  assert.equal(records[0].content, "weighing options");
  assert.equal(
    records[2].content,
    '[{"name":"read_file","args":{"path":"a"}}]',
  );
});

test("recordsFor names what it cannot classify by the native type", () => {
  const [error] = recordsFor({ type: "ERROR_MESSAGE", error: "503" }, "raw");
  assert.deepEqual(error, {
    kind: "other",
    unmappedKind: "ERROR_MESSAGE",
    content: "503",
  });

  const [unknown] = recordsFor({ type: "TOOL_BARF" }, "raw");
  assert.equal(unknown.unmappedKind, "TOOL_BARF");

  const [empty] = recordsFor({}, "raw");
  assert.equal(empty.unmappedKind, "unknown");
});

test("recordsFor keeps a tool result as the call record the CLI wrote", () => {
  const [record] = recordsFor({ type: "GENERIC", content: "output" }, "raw");
  assert.equal(record.kind, "tool-call");
  assert.deepEqual(JSON.parse(record.content), {
    type: "GENERIC",
    content: "output",
  });
});

test("parseTranscript drops a half-written trailing line", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-transcript-"));
  const file = join(root, "transcript.jsonl");
  writeFileSync(
    file,
    '{"type":"USER_INPUT","content":"a"}\n{"type":"PLANNER_RESP',
  );
  const entries = parseTranscript(file);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].value.type, "USER_INPUT");
});

test("parseTranscript keeps a line that does not parse, as loss", () => {
  const root = mkdtempSync(join(tmpdir(), "agy-transcript-"));
  const file = join(root, "transcript.jsonl");
  writeFileSync(file, 'not json\n{"type":"USER_INPUT","content":"a"}\n');
  const entries = parseTranscript(file);
  assert.equal(entries[0].value, undefined);
  const records = [...sessionSource({ id: "c1", entries }).records];
  assert.deepEqual(
    records.map((record) => record.kind),
    ["unparseable", "user"],
  );
});

/* ── finding the run's conversation ─────────────────────────────────────── */

/** A store with one conversation per entry, written the way the CLI writes them. */
function brainWith(conversations) {
  const root = mkdtempSync(join(tmpdir(), "agy-brain-"));
  for (const [id, opening] of conversations) {
    const file = transcriptPath(join(root, id));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({
        type: "USER_INPUT",
        content: `<USER_REQUEST>${opening}</USER_REQUEST>`,
      })}\n`,
    );
  }
  return root;
}

test("findRunConversation finds the conversation this spawn opened", () => {
  const root = brainWith([
    ["other", "Do something else"],
    ["wanted", "Read the task in /tmp/pi-cowboy/abc12345/task.md"],
  ]);
  const conversation = findRunConversation({
    subagentId: "abc12345",
    taskFile: "/tmp/pi-cowboy/abc12345/task.md",
    root,
  });
  assert.equal(conversation.id, "wanted");
  assert.equal(conversation.file, transcriptPath(join(root, "wanted")));
});

test("findRunConversation matches on the spawn id the task prompt opens with", () => {
  const root = brainWith([["renamed", "Read the task for spawn abc12345"]]);
  const conversation = findRunConversation({ subagentId: "abc12345", root });
  assert.equal(conversation.id, "renamed");
});

test("findRunConversation refuses rather than guessing at the newest", () => {
  const root = brainWith([["other", "Do something else"]]);
  assert.throws(
    () => findRunConversation({ subagentId: "abc12345", root }),
    /answers to spawn abc12345/,
  );
});

test("findRunConversation refuses when the store is missing", () => {
  assert.throws(
    () =>
      findRunConversation({ subagentId: "abc12345", root: "/nonexistent/agy" }),
    /No Antigravity conversation store/,
  );
});

test("findRunConversation prefers the live conversation of a restarted run", () => {
  const root = brainWith([
    ["first", "Read the task in /tmp/pi-cowboy/abc12345/task.md"],
    ["second", "Read the task in /tmp/pi-cowboy/abc12345/task.md"],
  ]);
  // Writes land in the same millisecond on a fast disk; the tie-break is stable
  // only in the sense that either conversation belongs to this spawn.
  const conversation = findRunConversation({
    subagentId: "abc12345",
    taskFile: "/tmp/pi-cowboy/abc12345/task.md",
    root,
  });
  assert.ok(["first", "second"].includes(conversation.id));
});

test("brainRoot reads the store under the home directory", () => {
  assert.equal(
    brainRoot({ HOME: "/home/worker" }),
    "/home/worker/.gemini/antigravity-cli/brain",
  );
});

/* ── the harness contract ───────────────────────────────────────────────── */

test("the harness registers its identity and multiplexer kind", () => {
  const { harness } = harnessFrom();
  assert.equal(harness.id, "antigravity");
  assert.equal(harness.displayName, "Antigravity CLI");
  assert.equal(harness.agentMultiplexerKind, "agy");
  assert.equal(typeof harness.postStart, "function");
  assert.equal(typeof harness.steer, "function");
  assert.equal(typeof harness.readHandoverRecords, "function");
  assert.equal(typeof harness.availability, "function");
});

test("availability follows agy on PATH", () => {
  const bin = mkdtempSync(join(tmpdir(), "agy-bin-"));
  const empty = join(bin, "empty");
  mkdirSync(empty);

  // Each answer is proved against a `PATH` this test owns rather than the one
  // the machine happens to have: a CI runner has no `agy` installed, and the
  // developer's own `PATH` should not decide what this test asserts.
  const missing = availabilityOf({ PATH: empty });
  assert.equal(missing.status, "unavailable");
  assert.match(missing.notice, /agy on PATH/);

  // A zero-byte file is all `onPath` looks for: an executable entry. Windows
  // has no execute bit, so the mode is a no-op the test does not depend on.
  const agy = join(bin, "agy");
  writeFileSync(agy, "");
  chmodSync(agy, 0o755);
  assert.deepEqual(availabilityOf({ PATH: bin }), { status: "available" });
});

test("prepare stages the definition and the trust override", async () => {
  const { harness } = harnessFrom();
  const { launch: staged } = stagedLaunch();
  const ran = [];
  await harness.prepare({
    pane: silentPane({ run: async (_paneId, command) => ran.push(command) }),
    paneId: "wSW:p1",
    cwd: "/private/tmp/work",
    launch: staged,
  });

  const definition = readFileSync(agentFileOf(staged), "utf8");
  assert.match(definition, /excludeDefaultComponents: true/);
  assert.match(
    definition,
    /tools: \[read_file, edit_file, write_file, run_command, search_web\]/,
  );
  assert.match(definition, /You are a worker\./);

  assert.deepEqual(JSON.parse(readFileSync(settingsFileOf(staged), "utf8")), {
    trustedWorkspaces: ["/private/tmp/work"],
  });

  assert.equal(ran.length, 1);
  assert.match(ran[0], /test -r '.*pi-cowboy-abc12345\.md'/);
  assert.match(ran[0], /test -r '.*task\.md'/);
  assert.match(ran[0], /command -v agy/);
  assert.match(ran[0], /AGY_""STAGED/);
});

test("prepare refuses when the pane never proves it can see the staged state", async () => {
  const { harness } = harnessFrom();
  const { launch: staged } = stagedLaunch();
  await assert.rejects(
    harness.prepare({
      pane: silentPane({
        waitForOutput: async () => {
          throw new Error("timeout");
        },
      }),
      paneId: "wSW:p1",
      cwd: "/private/tmp/work",
      launch: staged,
    }),
    /the pane never proved it can see the staged Antigravity state/,
  );
});

test("postStart waits for the composer, then submits the task", async () => {
  const { harness } = harnessFrom();
  const { launch: staged } = stagedLaunch();
  const waited = [];
  const prompted = [];
  await harness.postStart({
    pane: silentPane({
      waitForOutput: async (_paneId, output, timeoutMs) =>
        waited.push({ output, timeoutMs }),
      promptAgent: async (_paneId, message) => {
        prompted.push(message);
        return { kind: "submitted" };
      },
    }),
    paneId: "wSW:p1",
    cwd: "/private/tmp/work",
    launch: staged,
    signal: new AbortController().signal,
  });
  assert.equal(waited.length, 1);
  assert.equal(waited[0].output, "? for shortcuts");
  assert.equal(prompted.length, 1);
  assert.match(prompted[0], /This pi-cowboy spawn is abc12345\./);
  assert.match(prompted[0], /Read the task in "\/.*task\.md"/);
});

test("postStart refuses a pane with no agent surface, and a refused submit", async () => {
  const { harness } = harnessFrom();
  const { launch: staged } = stagedLaunch();
  await assert.rejects(
    harness.postStart({
      pane: silentPane(),
      paneId: "wSW:p1",
      cwd: "/private/tmp/work",
      launch: staged,
      signal: new AbortController().signal,
    }),
    /cannot submit a task/,
  );

  await assert.rejects(
    harness.postStart({
      pane: silentPane({
        promptAgent: async () => ({
          kind: "not-submitted",
          detail: "agent busy",
        }),
      }),
      paneId: "wSW:p1",
      cwd: "/private/tmp/work",
      launch: staged,
      signal: new AbortController().signal,
    }),
    /Antigravity did not accept the task: agent busy/,
  );
});

test("postStart never types into a pane the run was aborted in", async () => {
  const { harness } = harnessFrom();
  const { launch: staged } = stagedLaunch();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    harness.postStart({
      pane: silentPane({ promptAgent: async () => ({ kind: "submitted" }) }),
      paneId: "wSW:p1",
      cwd: "/private/tmp/work",
      launch: staged,
      signal: controller.signal,
    }),
  );
});

test("stop presses ctrl+c twice, which is what exits the TUI", async () => {
  const { harness } = harnessFrom();
  const presses = [];
  await harness.stop({
    pane: silentPane({ sendKeys: async (_paneId, keys) => presses.push(keys) }),
    paneId: "wSW:p1",
  });
  assert.deepEqual(presses, [["ctrl+c"], ["ctrl+c"]]);
});

test("steer submits through the agent surface, or reports the gap", async () => {
  const { harness } = harnessFrom();
  const prompted = [];
  const outcome = await harness.steer({
    pane: silentPane({
      promptAgent: async (_paneId, message) => {
        prompted.push(message);
        return { kind: "submitted" };
      },
    }),
    paneId: "wSW:p1",
    message: "Use the other file.",
    signal: new AbortController().signal,
  });
  assert.deepEqual(outcome, { kind: "submitted" });
  assert.deepEqual(prompted, ["Use the other file."]);

  const refused = await harness.steer({
    pane: silentPane(),
    paneId: "wSW:p1",
    message: "Use the other file.",
    signal: new AbortController().signal,
  });
  assert.equal(refused.kind, "not-submitted");
});

test("teardown removes what prepare staged, and is safe when it staged nothing", async () => {
  const { harness } = harnessFrom();
  const { launch: staged, root } = stagedLaunch();
  await harness.prepare({
    pane: silentPane(),
    paneId: "wSW:p1",
    cwd: "/private/tmp/work",
    launch: staged,
  });
  const definition = agentFileOf(staged);
  assert.equal(existsSync(definition), true);

  await harness.teardown({
    subagentId: "abc12345",
    paneId: "wSW:p1",
    cwd: "/private/tmp/work",
    pi: {},
  });
  assert.equal(existsSync(definition), false);
  assert.equal(existsSync(settingsFileOf(staged)), false);
  // The directories this plugin created are pruned; pi-cowboy's own files stay.
  assert.equal(existsSync(join(root, "abc12345", ".agents")), false);
  assert.equal(existsSync(staged.taskFile), true);

  await harness.teardown({
    subagentId: "abc12345",
    paneId: null,
    cwd: null,
    pi: {},
  });
});

test("teardown finds the staging of a run this process never prepared", async (t) => {
  const { harness } = harnessFrom();
  // The staging path is derived from the temporary directory, so the fixture
  // moves the process's `TMPDIR` into a directory of its own: the tree then
  // never touches the root real spawns use. Restoring it deletes the variable
  // when the runner had none — assigning `undefined` back would set it to the
  // literal string "undefined", which every later `os.tmpdir()` call reads.
  const home = mkdtempSync(join(tmpdir(), "agy-tmp-"));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = home;
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(home, { recursive: true, force: true });
  });

  const stagingDir = stagingDirectoryFor("abc12345");
  assert.equal(stagingDir, join(home, "pi-cowboy", "abc12345"));

  const definition = join(
    stagingDir,
    ".agents",
    "agents",
    "pi-cowboy-abc12345.md",
  );
  mkdirSync(join(definition, ".."), { recursive: true });
  writeFileSync(definition, "staged by an earlier process\n");
  writeFileSync(join(stagingDir, "agy-settings.json"), "{}\n");

  await harness.teardown({
    subagentId: "abc12345",
    paneId: null,
    cwd: null,
    pi: {},
  });
  assert.equal(existsSync(definition), false);
  assert.equal(existsSync(join(stagingDir, ".agents")), false);
  assert.equal(existsSync(join(stagingDir, "agy-settings.json")), false);
});

test("teardown keeps the directories pi-cowboy still uses", async () => {
  const { harness } = harnessFrom();
  const { launch: staged, root } = stagedLaunch();
  await harness.prepare({
    pane: silentPane(),
    paneId: "wSW:p1",
    cwd: "/private/tmp/work",
    launch: staged,
  });
  await harness.teardown({
    subagentId: staged.subagentId,
    paneId: null,
    cwd: null,
    pi: {},
  });
  assert.equal(existsSync(staged.taskFile), true);
  assert.equal(existsSync(join(root, "abc12345", ".agents")), false);
});

test("readHandoverRecords reads the conversation this spawn opened", async (t) => {
  const { harness } = harnessFrom();
  const { launch: staged, root } = stagedLaunch();
  // The store's location is `HOME`'s, so reading one end to end means pointing
  // `HOME` at a fixture. Nothing in the request can redirect it, and writing
  // into the developer's real conversation store is not an option. The restore
  // deletes the variable when the runner had none, rather than setting it to
  // the string "undefined".
  const home = mkdtempSync(join(tmpdir(), "agy-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  await harness.prepare({
    pane: silentPane(),
    paneId: "wSW:p1",
    cwd: root,
    launch: staged,
  });

  const file = transcriptPath(join(brainRoot(), "conversation-fixture"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(
    file,
    `${JSON.stringify({ type: "USER_INPUT", content: `<USER_REQUEST>Read the task in ${staged.taskFile}</USER_REQUEST>` })}\n`,
  );

  const source = await harness.readHandoverRecords({
    subagentId: staged.subagentId,
    paneId: "wSW:p1",
    cwd: root,
    startedAt: Date.now(),
    staged,
  });
  assert.equal(source.sessionId, "conversation-fixture");
  assert.deepEqual(
    [...source.records].map((record) => record.kind),
    ["user"],
  );

  await harness.teardown({
    subagentId: staged.subagentId,
    paneId: null,
    cwd: null,
    pi: {},
  });
});

test("listModels lists what the CLI reports", async () => {
  const { harness, calls } = harnessFrom({
    exec: async (command, args) =>
      args[0] === "models"
        ? {
            code: 0,
            stdout:
              "Fetching available models...\ngemini-3.8-flash-medium\tGemini 3.8 Flash\n",
            stderr: "",
          }
        : { code: 0, stdout: "1.5.9\n", stderr: "" },
  });
  const list = await harness.listModels({});
  assert.equal(list.kind, "listed");
  assert.deepEqual(
    list.entries.map((entry) => entry.key),
    ["gemini-3.8-flash-medium"],
  );
  assert.deepEqual(calls[0].args, ["models"]);
});

test("listModels reports a mismatch with the major it was written for", async () => {
  const { harness } = harnessFrom({
    exec: async (_command, args) =>
      args[0] === "models"
        ? {
            code: 0,
            stdout: "gemini-3.8-flash-medium\tGemini 3.8 Flash\n",
            stderr: "",
          }
        : { code: 0, stdout: "2.0.0\n", stderr: "" },
  });
  const list = await harness.listModels({});
  assert.equal(list.kind, "fallback");
  assert.match(list.notice, /written for/);
});

test("listModels reports an unreadable catalog rather than throwing", async () => {
  const failed = harnessFrom({
    exec: async () => ({ code: 3, stdout: "", stderr: "not signed in" }),
  }).harness;
  const failure = await failed.listModels({});
  assert.equal(failure.kind, "unavailable");
  assert.match(failure.notice, /not signed in/);

  const empty = harnessFrom({
    exec: async () => ({
      code: 0,
      stdout: "Fetching available models...\n",
      stderr: "",
    }),
  }).harness;
  const nothing = await empty.listModels({});
  assert.equal(nothing.kind, "unavailable");
  assert.match(nothing.notice, /returned no models/);
});

test("a failed exec is a throw, and a throwing exec is an unavailable list", async () => {
  const { harness } = harnessFrom({
    exec: async () => {
      throw new Error("agy is not installed");
    },
  });
  const list = await harness.listModels({});
  assert.equal(list.kind, "unavailable");
  assert.match(list.notice, /agy is not installed/);
});
