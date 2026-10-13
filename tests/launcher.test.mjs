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
  // The real library, so helpers such as tellico_key_file are the shipped
  // ones; the stubs below then replace what would touch the system.
  writeFileSync(join(installed, "lib/checks.sh"), readFileSync(join(root, "lib/checks.sh"), "utf8") + `
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
connection: process.env.TELLICO_CONNECTION,
gatewayUrl: process.env.TELLICO_CONNECTION_GATEWAY_URL,
exa: process.env.OPENCODE_ENABLE_EXA,
cli: process.env.OPENCODE_CLI_CONFIG_CONTENT
}));`);
  writeFileSync(join(bin, "opencode"), '#!/bin/sh\nexec "$TELLICO_TEST_NODE" "$TELLICO_TEST_CAPTURE" "$@"\n', { mode: 0o755 });
  const env = { PATH: bin + ":" + process.env.PATH, XDG_CONFIG_HOME: configHome,
    TELLICO_TEST_MAJOR: "2", TELLICO_TEST_NODE: process.execPath,
    TELLICO_TEST_CAPTURE: capture };
  return {
    dir,
    installed,
    run(args = [], extraEnv = {}) {
      const result = spawnSync("sh", [join(bin, "opencode-tellico"), ...args], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 5000,
      });
      assert.ifError(result.error);
      return { ...result, captured: result.status === 0 ? JSON.parse(result.stdout) : null };
    },
  };
}

test("default launch opens on build-tellico, keeps medium and enables interactive background dispatch", t => {
  const { captured, status } = fixture(t).run();
  assert.equal(status, 0);
  assert.equal(captured.background, "true");
  assert.equal(captured.config.default_agent, "build-tellico-1");
  assert.equal(config.agent[captured.config.default_agent].variant, "medium");
  assert.equal(captured.config.websearch.provider, "tavily");
});

test("orchestrate opens on the delegating lead", t => {
  const f = fixture(t);
  for (const launch of [f.run(["0", "--orchestrate"]), f.run(["0"], { TELLICO_SOLO: "0" })]) {
    assert.equal(launch.status, 0);
    assert.equal(launch.captured.config.default_agent, "orchestrate-tellico-0");
  }
  assert.equal(f.run(["0", "--solo"]).captured.config.default_agent, "build-tellico-0");
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

test("serve starts a private API server with the session config and interactive background dispatch", t => {
  const { captured, status } = fixture(t).run(["0", "--orchestrate", "--think", "low", "serve",
    "--hostname", "127.0.0.1", "--port", "4123"], { OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false" });
  assert.equal(status, 0);
  // No --standalone: plain serve is already private, only --service is shared.
  assert.deepEqual(captured.args, ["serve", "--hostname", "127.0.0.1", "--port", "4123"]);
  assert.equal(captured.background, "true");
  assert.equal(captured.config.default_agent, "orchestrate-tellico-0");
  assert.equal(captured.config.agent["tellico-worker-1"].variant, "low");
  assert.equal(captured.config.websearch.provider, "tavily");
});

test("serve still honours a disabled background mode", t => {
  const { captured } = fixture(t).run(["serve"], { TELLICO_BACKGROUND_SUBAGENTS: "0" });
  assert.equal(captured.background, "false");
  assert.deepEqual(captured.args, ["serve"]);
});

test("no --connection leaves the installed providers alone", t => {
  const { captured } = fixture(t).run(["serve"]);
  assert.equal(captured.config.provider, undefined);
  assert.equal(captured.connection, undefined);
});

test("--connection gateway repoints all four providers at the gateway with its own key file", t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, "client.env"),
    "TELLICO_MODE='tunnel'\nTELLICO_GATEWAY_URL='https://gw.example/v1'\nTELLICO_QWEN_PORT0='18080'\nTELLICO_QWEN_PORT1='18081'\n");
  writeFileSync(join(f.installed, "api-key.gateway"), "k", { mode: 0o600 });
  const { captured, status } = f.run(["--connection", "gateway", "serve"]);
  assert.equal(status, 0);
  const key = `{file:${join(f.installed, "api-key.gateway")}}`;
  assert.deepEqual(captured.config.provider, {
    "tellico-0": { options: { baseURL: "https://gw.example/v1/node0", apiKey: key } },
    "tellico-0-worker": { options: { baseURL: "https://gw.example/v1/node0", apiKey: key } },
    "tellico-1": { options: { baseURL: "https://gw.example/v1/node1", apiKey: key } },
    "tellico-1-worker": { options: { baseURL: "https://gw.example/v1/node1", apiKey: key } },
  });
  // The tunnel helper sees the same choice, so it only probes the gateway.
  assert.equal(captured.connection, "gateway");
  assert.equal(captured.gatewayUrl, "https://gw.example/v1");
});

test("--connection gateway refuses to start without a gateway key", t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, "client.env"), "TELLICO_MODE='tunnel'\nTELLICO_GATEWAY_URL='https://gw.example/v1'\n");
  const r = f.run(["serve"], { TELLICO_CONNECTION: "gateway" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no gateway API key/);
});

test("--connection tunnel on a gateway install uses loopback ports and api-key.tunnel", t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, "client.env"), "TELLICO_MODE='gateway'\nTELLICO_GATEWAY_URL='https://gw.example/v1'\nTELLICO_QWEN_PORT0='19000'\n");
  const { captured } = f.run(["serve"], { TELLICO_CONNECTION: "tunnel" });
  assert.equal(captured.config.provider["tellico-0"].options.baseURL, "http://127.0.0.1:19000/v1");
  assert.equal(captured.config.provider["tellico-1-worker"].options.baseURL, "http://127.0.0.1:18081/v1");
  assert.equal(captured.config.provider["tellico-1"].options.apiKey, `{file:${join(f.installed, "api-key.tunnel")}}`);
});

test("--connection on the installed mode keeps the installed key file", t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, "client.env"), "TELLICO_MODE='tunnel'\n");
  const { captured } = f.run(["serve"], { TELLICO_CONNECTION: "tunnel" });
  assert.equal(captured.config.provider["tellico-0"].options.apiKey, `{file:${join(f.installed, "api-key")}}`);
});

test("an unknown connection fails before anything starts", t => {
  const r = fixture(t).run(["--connection", "ssh"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown connection/);
});

test("every thinking setting reaches the request on OpenCode 1 and 2", () => {
  // OpenCode 2 sends only `extraBody` from model options and variants
  // (measured on 2.0.26); OpenCode 1 sends the keys themselves. Each must
  // carry both, identically, or one release silently loses thinking control.
  for (const [id, provider] of Object.entries(config.provider)) {
    const model = provider.models["qwen3.8-27b-gsq-iq3s"];
    for (const [level, variant] of Object.entries(model.variants)) {
      assert.deepEqual(variant.extraBody?.chat_template_kwargs, variant.chat_template_kwargs, `${id} ${level}`);
    }
    for (const key of ["temperature", "top_p", "parallel_tool_calls"]) {
      assert.deepEqual(model.options.extraBody[key], model.options[key], `${id} ${key}`);
    }
    // Deliberately absent: a per-launch config can add a key to the
    // installed model's extraBody but not replace one (measured on 2.0.26),
    // so a default here would make --think a no-op on OpenCode 2.
    assert.equal(model.options.extraBody.chat_template_kwargs, undefined, id);
  }
});

test("each provider has a no-thinking twin of the model for session overhead", () => {
  for (const [id, provider] of Object.entries(config.provider)) {
    const model = provider.models["qwen3.8-27b-gsq-iq3s"];
    const quiet = provider.models["qwen3.8-27b-gsq-iq3s-quiet"];
    assert.ok(quiet, id);
    // Same server model and context coupling; only thinking differs.
    assert.equal(quiet.id, "qwen3.8-27b-gsq-iq3s");
    assert.deepEqual(quiet.limit, model.limit);
    // No variants, so a session's variant has nothing to switch back on.
    assert.equal(quiet.variants, undefined);
    assert.equal(quiet.options.chat_template_kwargs.enable_thinking, false);
    assert.equal(quiet.options.extraBody.chat_template_kwargs.enable_thinking, false);
  }
});

test("title, summary, compaction and small_model use the no-thinking model", t => {
  const { captured } = fixture(t).run(["0", "--think", "xhigh"]);
  const quiet = "tellico-0/qwen3.8-27b-gsq-iq3s-quiet";
  assert.equal(captured.config.model, "tellico-0/qwen3.8-27b-gsq-iq3s");
  assert.equal(captured.config.small_model, quiet);
  for (const agent of ["title", "summary", "compaction"]) assert.equal(captured.config.agent[agent].model, quiet);
});

test("--think sets the model-level level on OpenCode 2, where agent variants are not applied", t => {
  const f = fixture(t);
  const { captured } = f.run(["0", "--think", "low"]);
  for (const id of ["tellico-0", "tellico-0-worker", "tellico-1", "tellico-1-worker"]) {
    assert.deepEqual(captured.config.provider[id], {
      models: { "qwen3.8-27b-gsq-iq3s": { options: { extraBody: { chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" } } } } },
    });
  }
  const off = f.run(["0", "--think", "off"]).captured;
  assert.deepEqual(off.config.provider["tellico-1"].models["qwen3.8-27b-gsq-iq3s"].options.extraBody.chat_template_kwargs, { enable_thinking: false });
  // The quiet model is never overridden.
  assert.equal(off.config.provider["tellico-1"].models["qwen3.8-27b-gsq-iq3s-quiet"], undefined);
});

test("OpenCode 1 gets --think through agent variants only", t => {
  const { captured } = fixture(t).run(["0", "--think", "low"], { TELLICO_TEST_MAJOR: "1" });
  assert.equal(captured.config.provider, undefined);
  assert.equal(captured.config.agent["build-tellico-0"].variant, "low");
  // and keeps the plain model for overhead, where compaction-guard applies.
  assert.equal(captured.config.agent.title.model, "tellico-0/qwen3.8-27b-gsq-iq3s");
  assert.equal(captured.config.small_model, "tellico-0/qwen3.8-27b-gsq-iq3s");
});

test("--connection and --think share one provider block", t => {
  const f = fixture(t);
  writeFileSync(join(f.installed, "client.env"), "TELLICO_MODE='tunnel'\nTELLICO_GATEWAY_URL='https://gw.example/v1'\n");
  writeFileSync(join(f.installed, "api-key.gateway"), "k", { mode: 0o600 });
  const { captured } = f.run(["--connection", "gateway", "--think", "xhigh", "serve"]);
  const entry = captured.config.provider["tellico-1-worker"];
  assert.equal(entry.options.baseURL, "https://gw.example/v1/node1");
  assert.equal(entry.models["qwen3.8-27b-gsq-iq3s"].options.extraBody.chat_template_kwargs.reasoning_effort, "xhigh");
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

test("magic-context is on by default, names only its pinned package and turns native compaction off", t => {
  const f = fixture(t);
  for (const launch of [f.run(["0"]), f.run(["0", "--magic-context"]), f.run(["0"], { TELLICO_MAGIC_CONTEXT: "1" })]) {
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

test("no-magic-context names no plugin, so the installed list is not appended to", t => {
  const f = fixture(t);
  for (const launch of [f.run(["0", "--no-magic-context"]), f.run(["0"], { TELLICO_MAGIC_CONTEXT: "0" })]) {
    assert.equal(launch.status, 0);
    assert.equal(launch.captured.config.plugin, undefined);
    assert.equal(launch.captured.config.compaction, undefined);
  }
});

test("magic-context refuses to start without the plugin's config", t => {
  const f = fixture(t);
  rmSync(join(f.dir, "config/cortexkit/magic-context.jsonc"));
  const result = f.run(["0"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /install\.sh --no-start/);
  assert.match(result.stderr, /--no-magic-context/);
  assert.equal(f.run(["0", "--no-magic-context"]).status, 0);
});

test("pi loads the same pinned Magic Context version as opencode-tellico", () => {
  const settings = JSON.parse(readFileSync(join(root, "pi/settings.json"), "utf8"));
  const launcher = readFileSync(join(root, "bin/opencode-tellico"), "utf8");
  const opencodeVersion = launcher.match(/@cortexkit\/opencode-magic-context@(\d+\.\d+\.\d+)/)[1];
  // Both processes share one database, and mismatched versions on it block
  // each other's migrations.
  assert.deepEqual(settings.packages, [`npm:@cortexkit/pi-magic-context@${opencodeVersion}`]);
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
  const piModels = JSON.parse(readFileSync(join(root, "pi/models.json"), "utf8"));
  const piEntries = [mc.historian.pi.model, ...mc.historian.pi.fallback_models];
  assert.deepEqual(piEntries.map(entry => entry.model.split("/")[0]), ["tellico-1", "tellico-0"]);
  for (const entry of piEntries) {
    const [provider, modelID] = entry.model.split("/");
    assert.ok(piModels.providers[provider].models.some(model => model.id === modelID));
    assert.equal(entry.thinking_level, "off");
  }
  assert.equal(mc.embedding.provider, "off");
  assert.equal(mc.prompt_surface.default, "light");
  assert.equal(mc.auto_update, false);
  assert.equal(mc.dreamer, undefined);
});
