import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config/opencode.json"), "utf8"));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-launcher-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const configHome = join(dir, "config");
  const installed = join(configHome, "tellico-qwen");
  mkdirSync(bin);
  mkdirSync(join(installed, "lib"), { recursive: true });
  copyFileSync(join(root, "bin/opencode-tellico"), join(bin, "opencode-tellico"));
  writeFileSync(join(bin, "tellico-qwen-tunnel"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(installed, "opencode.json"), JSON.stringify(config));
  mkdirSync(join(configHome, "cortexkit"));
  writeFileSync(join(configHome, "cortexkit/magic-context.jsonc"), "{}\n");
  writeFileSync(join(installed, "lib/checks.sh"), `
tellico_default_lead_node() { printf '1\\n'; }
tellico_opencode_standalone_flag() { printf '%s\\n' --standalone; }
tellico_opencode_major() { printf '%s\\n' "$TELLICO_TEST_MAJOR"; }
tellico_cli_plugin_overlay() { printf '%s\\n' '{"plugins":["kept-user-plugin"]}'; }
`);
  const capture = join(dir, "capture.mjs");
  writeFileSync(capture, `process.stdout.write(JSON.stringify({
args: process.argv.slice(2),
config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT),
background: process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS,
lead: process.env.TELLICO_LEAD_NODE,
exa: process.env.OPENCODE_ENABLE_EXA,
cli: process.env.OPENCODE_CLI_CONFIG_CONTENT
}));`);
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\nexec "$TELLICO_TEST_NODE" "$TELLICO_TEST_CAPTURE" "$@"\n', { mode: 0o755 });
  const env = { PATH: bin + ":" + process.env.PATH, XDG_CONFIG_HOME: configHome,
    TELLICO_TEST_MAJOR: "2", TELLICO_TEST_NODE: process.execPath,
    TELLICO_TEST_CAPTURE: capture };
  return {
    dir,
    run(args = [], extraEnv = {}) {
      const result = spawnSync("sh", [join(bin, "opencode-tellico"), ...args], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 5000,
      });
      assert.ifError(result.error);
      return { ...result, captured: result.status === 0 ? JSON.parse(result.stdout) : null };
    },
  };
}

test("default launch keeps medium and enables interactive background dispatch", t => {
  const { captured, status } = fixture(t).run();
  assert.equal(status, 0);
  assert.equal(captured.background, "true");
  assert.equal(captured.config.default_agent, "orchestrate-tellico-1");
  assert.equal(config.agent[captured.config.default_agent].variant, "medium");
  assert.equal(captured.config.websearch.provider, "tavily");
});

test("disabled mode overrides an inherited upstream enable flag", t => {
  const { captured } = fixture(t).run(["0"], {
    TELLICO_BACKGROUND_SUBAGENTS: "0", OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
  });
  assert.equal(captured.background, "false");
});

test("one-shot run is foreground despite both inherited background flags", t => {
  const { captured } = fixture(t).run(["0", "run", "Review this repository"], {
    TELLICO_BACKGROUND_SUBAGENTS: "1", OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
  });
  assert.equal(captured.background, "false");
  assert.deepEqual(captured.args, ["run", "--standalone", "--model",
    "tellico-0/qwen3.8-27b-gsq-iq3s", "Review this repository"]);
});

test("step and thinking overlays extend both primaries but keep worker limits", t => {
  const { captured } = fixture(t).run(["1", "--solo", "--think", "low", "--steps", "100000"]);
  assert.equal(captured.config.default_agent, "build-tellico-1");
  for (const name of ["build-tellico-0", "build-tellico-1", "orchestrate-tellico-0", "orchestrate-tellico-1"]) {
    assert.equal(captured.config.agent[name].steps, 100000);
    assert.equal(captured.config.agent[name].variant, "low");
  }
  for (const name of ["tellico-worker-0", "tellico-worker-1"]) {
    assert.equal(captured.config.agent[name].variant, "low");
    assert.equal(captured.config.agent[name].steps, undefined);
    assert.equal(config.agent[name].steps, 200);
  }
});

test("OpenCode 1 uses its provider environment rather than a v2 config entry", t => {
  const { captured } = fixture(t).run(["0"], { TELLICO_TEST_MAJOR: "1" });
  assert.equal(captured.exa, "1");
  assert.equal(captured.config.websearch, undefined);
});

test("invalid thinking and zero steps fail before any launcher service call", t => {
  const f = fixture(t);
  assert.equal(f.run(["--think", "high"]).status, 2);
  assert.equal(f.run(["--steps", "0"]).status, 2);
});

test("lead can implement and verify directly without enabling arbitrary subagents", () => {
  for (const n of ["0", "1"]) {
    const lead = config.agent["orchestrate-tellico-" + n];
    assert.equal(lead.permission.bash, "allow");
    assert.equal(lead.permission.edit, "allow");
    assert.equal(lead.permission.websearch, "allow");
    assert.equal(lead.permission["*"], undefined);
    assert.equal(lead.permission.task["*"], "deny");
    assert.equal(lead.permission.task["tellico-worker-0"], "allow");
    assert.equal(lead.permission.task["tellico-worker-1"], "allow");
    assert.equal(lead.steps, 200);
    assert.equal(config.agent["build-tellico-" + n].permission.task, "deny");
  }
  for (const provider of Object.values(config.provider)) {
    const model = provider.models["qwen3.8-27b-gsq-iq3s"];
    assert.equal(model.limit.context, 131072);
    assert.equal(model.limit.input, 131072);
    assert.equal(model.variants.medium.chat_template_kwargs.reasoning_effort, "medium");
  }
  assert.equal(config.compaction.reserved, 40000);
});

test("default launch names no plugin, so the installed list is not appended to", t => {
  const { captured } = fixture(t).run(["0"]);
  assert.equal(captured.config.plugin, undefined);
  assert.equal(captured.config.compaction, undefined);
});

test("magic-context names only its pinned package and turns native compaction off", t => {
  const f = fixture(t);
  for (const launch of [f.run(["0", "--magic-context"]), f.run(["0"], { TELLICO_MAGIC_CONTEXT: "1" })]) {
    assert.equal(launch.status, 0);
    const { plugin, compaction } = launch.captured.config;
    // A runtime plugin list is appended to the file's, and a plugin named in
    // both loads twice, so the three local plugins must not be repeated here.
    assert.equal(plugin.length, 1);
    assert.match(plugin[0], /^@cortexkit\/opencode-magic-context@\d+\.\d+\.\d+$/);
    assert.deepEqual(compaction, { auto: false, prune: false });
  }
  assert.equal(f.run(["0"], { TELLICO_MAGIC_CONTEXT: "maybe" }).status, 2);
});

test("magic-context refuses to start without the plugin's config", t => {
  const f = fixture(t);
  rmSync(join(f.dir, "config/cortexkit/magic-context.jsonc"));
  const result = f.run(["0", "--magic-context"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install\.sh --no-start/);
  assert.equal(f.run(["0"]).status, 0);
});

test("the magic-context template points its historian at worker providers without thinking", () => {
  const text = readFileSync(join(root, "config/magic-context.jsonc"), "utf8")
    .split("\n").filter(line => !/^\s*\/\//.test(line)).join("\n");
  const mc = JSON.parse(text);
  const entries = [mc.historian.opencode.model, ...mc.historian.opencode.fallback_models];
  assert.equal(entries.length, 2);
  for (const entry of entries) {
    const [provider, modelID] = entry.model.split("/");
    assert.match(provider, /^tellico-[01]-worker$/);
    const model = config.provider[provider].models[modelID];
    assert.equal(model.variants[entry.variant].chat_template_kwargs.enable_thinking, false);
  }
  assert.equal(mc.embedding.provider, "off");
  assert.equal(mc.prompt_surface.default, "light");
  assert.equal(mc.auto_update, false);
  assert.equal(mc.dreamer, undefined);
});
