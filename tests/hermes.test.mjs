import assert from "node:assert/strict";
import { test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const template = readFileSync(join(root, "hermes/config.yaml"), "utf8");

const URL0 = "https://gw.example/v1/node0";
const URL1 = "https://gw.example/v1/node1";

// --- the launcher ----------------------------------------------------------

function fixture(t, { overlays = [0, 1] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-hermes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const configHome = join(dir, "config");
  const installed = join(configHome, "tellico-qwen");
  mkdirSync(bin);
  mkdirSync(join(installed, "lib"), { recursive: true });
  copyFileSync(join(root, "bin/hermes-tellico"), join(bin, "hermes-tellico"));
  writeFileSync(join(bin, "tellico-qwen-tunnel"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The shipped library, with only the host-dependent helper stubbed out.
  writeFileSync(join(installed, "lib/checks.sh"),
    readFileSync(join(root, "lib/checks.sh"), "utf8") +
    "\ntellico_default_lead_node() { printf '%s\\n' \"${TELLICO_LEAD_NODE:-1}\"; }\n");
  for (const node of overlays) {
    mkdirSync(join(installed, `hermes/node${node}`), { recursive: true });
    writeFileSync(join(installed, `hermes/node${node}/config.yaml`),
      render(node));
  }
  // Stands in for the agent: reports what the launcher handed it.
  const capture = join(dir, "capture.mjs");
  writeFileSync(capture, `process.stdout.write(JSON.stringify({
args: process.argv.slice(2),
managedDir: process.env.HERMES_MANAGED_DIR
}));`);
  writeFileSync(join(bin, "hermes"),
    '#!/bin/sh\nexec "$TELLICO_TEST_NODE" "$TELLICO_TEST_CAPTURE" "$@"\n', { mode: 0o755 });
  const env = {
    PATH: bin + ":" + process.env.PATH, XDG_CONFIG_HOME: configHome,
    TELLICO_TEST_NODE: process.execPath, TELLICO_TEST_CAPTURE: capture,
  };
  return {
    installed,
    run(args = [], extraEnv = {}) {
      const result = spawnSync("sh", [join(bin, "hermes-tellico"), ...args], {
        env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 5000,
      });
      assert.ifError(result.error);
      // The stub prints JSON; a run that never reached it (--help, a refused
      // option) prints prose, so parsing is best-effort.
      let captured = null;
      if (result.status === 0 && result.stdout.startsWith("{")) {
        captured = JSON.parse(result.stdout);
      }
      return { ...result, captured };
    },
  };
}

test("an explicit node chooses that node's overlay", (t) => {
  const f = fixture(t);
  for (const node of [0, 1]) {
    const { status, captured } = f.run([String(node)]);
    assert.equal(status, 0);
    assert.equal(captured.managedDir, join(f.installed, `hermes/node${node}`));
  }
});

test("with no node the shared device-derived one is used", (t) => {
  const f = fixture(t);
  assert.equal(f.run([]).captured.managedDir, join(f.installed, "hermes/node1"));
  assert.equal(f.run([], { TELLICO_LEAD_NODE: "0" }).captured.managedDir,
    join(f.installed, "hermes/node0"));
});

test("the model and provider are left to the overlay, not passed as flags", (t) => {
  // "hermes -z" refuses --provider without --model, so a launcher that
  // passed either would break every one-shot caller.
  const { captured } = fixture(t).run(["0", "-z", "hello"]);
  assert.deepEqual(captured.args, ["-z", "hello"]);
});

test("arguments after the options reach the agent untouched", (t) => {
  const { captured } = fixture(t).run(
    ["1", "--think", "low", "chat", "--worktree", "--", "-z"]);
  assert.deepEqual(captured.args, ["--reasoning", "low", "chat", "--worktree", "--", "-z"]);
});

test("thinking levels the chat template accepts are forwarded", (t) => {
  const f = fixture(t);
  for (const [given, sent] of [["low", "low"], ["medium", "medium"], ["xhigh", "xhigh"],
    ["none", "none"], ["off", "none"]]) {
    const { status, captured } = f.run(["0", "--think", given]);
    assert.equal(status, 0, `--think ${given} should be accepted`);
    assert.deepEqual(captured.args, ["--reasoning", sent]);
  }
});

test("TELLICO_THINK is the default and --think overrides it", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.run(["0"], { TELLICO_THINK: "xhigh" }).captured.args,
    ["--reasoning", "xhigh"]);
  assert.deepEqual(f.run(["0", "--think", "low"], { TELLICO_THINK: "xhigh" }).captured.args,
    ["--reasoning", "low"]);
});

test("Hermes' own levels the chat template rejects are refused here", (t) => {
  // The template raises on these, which reaches the client as an HTTP 500,
  // and Hermes turns three retries of that into an empty answer. Failing
  // before the request is the only place it can be explained.
  const f = fixture(t);
  for (const level of ["minimal", "high", "max", "ultra"]) {
    const { status, stderr } = f.run(["0", "--think", level]);
    assert.equal(status, 2, `--think ${level} should be refused`);
    assert.match(stderr, /does not accept thinking level/);
    assert.match(stderr, /off, low, medium, xhigh/);
  }
  const unknown = f.run(["0", "--think", "banana"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown thinking level/);
  const bare = f.run(["0", "--think"]);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /requires a level/);
});

test("a missing overlay is reported rather than silently skipped", (t) => {
  // Without the variable Hermes would start happily on the user's own
  // provider, so this has to fail instead of falling through.
  const { status, stderr } = fixture(t, { overlays: [0] }).run(["1"]);
  assert.equal(status, 1);
  assert.match(stderr, /missing .*hermes\/node1\/config\.yaml/);
  assert.match(stderr, /install\.sh/);
});

test("--help needs no install", (t) => {
  const { status, stdout } = fixture(t, { overlays: [] }).run(["--help"]);
  assert.equal(status, 0);
  assert.match(stdout, /usage: hermes-tellico/);
});

// --- rendering the overlay -------------------------------------------------

function sh(script) {
  const result = spawnSync("sh", ["-c", `. "${join(root, "lib/checks.sh")}"\n${script}`],
    { encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

function render(node) {
  const { status, stdout, stderr } = sh(
    `tellico_render_hermes_config "${join(root, "hermes/config.yaml")}" ` +
    `"${URL0}" "${URL1}" /conf ${node}`);
  assert.equal(status, 0, stderr);
  return stdout;
}

test("rendering fills every placeholder", (t) => {
  for (const node of [0, 1]) {
    assert.doesNotMatch(render(node), /__TELLICO_/,
      `node ${node} still has a placeholder`);
  }
  // The template is the only thing that knows which placeholders exist, so
  // check it really has the ones the renderer fills -- otherwise this test
  // would pass just as well against a template with none.
  for (const placeholder of ["__TELLICO_BASE_URL_0__", "__TELLICO_BASE_URL_1__",
    "__TELLICO_CONFIG_DIR__", "__TELLICO_BASE_URL_LEAD__",
    "__TELLICO_LEAD__", "__TELLICO_PEER__"]) {
    assert.ok(template.includes(placeholder), `template is missing ${placeholder}`);
  }
});

test("each node's overlay pins itself and sends subagents to the other", (t) => {
  const node0 = render(0);
  assert.match(node0, /^ {2}provider: tellico-0$/m);
  assert.match(node0, /^ {2}provider: tellico-1-worker$/m);
  assert.match(node0, new RegExp(`^ {2}base_url: ${URL0}$`, "m"));

  const node1 = render(1);
  assert.match(node1, /^ {2}provider: tellico-1$/m);
  assert.match(node1, /^ {2}provider: tellico-0-worker$/m);
  assert.match(node1, new RegExp(`^ {2}base_url: ${URL1}$`, "m"));
});

test("both nodes declare all four providers against the right endpoints", (t) => {
  for (const node of [0, 1]) {
    const out = render(node);
    for (const name of ["tellico-0", "tellico-1", "tellico-0-worker", "tellico-1-worker"]) {
      assert.match(out, new RegExp(`^ {2}${name}:$`, "m"), `${name} missing from node ${node}`);
    }
    // Two entries per node URL: the plain provider and its worker twin.
    for (const url of [URL0, URL1]) {
      assert.equal(out.split(`api: ${url}\n`).length - 1, 2,
        `node ${node} should name ${url} twice`);
    }
    // The key is read per request from a file, so the overlay itself holds
    // no secret and a refetched key is picked up without reinstalling.
    assert.match(out, /key_cmd: cat \/conf\/api-key/);
    assert.doesNotMatch(out, /^ *api_key:/m);
    // Only the workers carry the role header the gateway admits leads ahead of.
    assert.equal(out.split("X-Tellico-Role: worker").length - 1, 2);
  }
});

test("subagents are capped at the slots one node has", (t) => {
  // Hermes defaults to 10. Every child lands on the peer node's two slots, so
  // a higher cap converts finished work into gateway queue timeouts (120s,
  // and workers starve first by design).
  for (const node of [0, 1]) {
    assert.match(render(node), /^  max_concurrent_children: 2$/m);
  }
});

test("the check rejects an overlay that oversubscribes the cluster", (t) => {
  const greedy = render(0).replace("  max_concurrent_children: 2", "  max_concurrent_children: 10");
  const result = checkHermes(t, greedy);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not cap subagents/);
});

test("summaries are pinned non-reasoning on the session's own node", (t) => {
  // The rule plugins/compaction-guard/ enforces under OpenCode. Hermes only
  // certifies the non-reasoning path when provider and model match the route
  // the call resolves to, so all three keys have to be there.
  for (const node of [0, 1]) {
    const out = render(node);
    const aux = out.slice(out.indexOf("\nauxiliary:"), out.indexOf("\ndelegation:"));
    for (const task of ["compression", "session_search"]) {
      assert.match(aux, new RegExp(`^  ${task}:$`, "m"), `${task} missing from node ${node}`);
    }
    assert.equal(aux.split("reasoning_effort: none").length - 1, 2);
    assert.equal(aux.split(`provider: tellico-${node}\n`).length - 1, 2,
      `node ${node} should summarise on its own node`);
    // Not the peer, which is where the subagents go.
    assert.doesNotMatch(aux, new RegExp(`provider: tellico-${node === 0 ? 1 : 0}`));
  }
});

test("the check rejects an overlay whose summaries would think", (t) => {
  const unguarded = render(0).replace(/^    reasoning_effort: none$/gm, "    reasoning_effort: medium");
  const result = checkHermes(t, unguarded);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not turn reasoning off/);
});

test("the overlay agrees with opencode.json on the model and context", (t) => {
  // Nothing enforces this across the two config formats, and a context
  // larger than a slot is accepted by both and then truncated upstream.
  const opencode = JSON.parse(readFileSync(join(root, "config/opencode.json"), "utf8"));
  const limit = opencode.provider["tellico-0"].models["qwen3.8-27b-gsq-iq3s"].limit;
  const out = render(0);
  assert.match(out, /default: qwen3\.8-27b-gsq-iq3s/);
  assert.match(out, new RegExp(`^ {2}context_length: ${limit.context}$`, "m"));
  assert.match(out, new RegExp(`^ {2}max_tokens: ${limit.output}$`, "m"));
});

test("the template indents with spaces only", (t) => {
  // YAML rejects a tab outright, and Hermes answers a file it cannot parse
  // by ignoring it, which is the failure that looks like success.
  assert.doesNotMatch(template, /\t/);
});

// --- checking and drift ----------------------------------------------------

function checkHermes(t, body, node = 0) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-hermes-check-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.yaml");
  writeFileSync(file, body);
  return sh(`tellico_check_hermes "${file}" ${node}`);
}

test("a rendered overlay passes its own check", (t) => {
  for (const node of [0, 1]) {
    assert.equal(checkHermes(t, render(node), node).status, 0);
  }
});

test("the check rejects an overlay that would start on the wrong node", (t) => {
  const wrong = checkHermes(t, render(1), 0);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not pin model\.provider to tellico-0/);
});

test("the check rejects an unrendered template", (t) => {
  // Placeholders are valid YAML, so nothing downstream would object: the
  // request would just go to a host named after the placeholder.
  const raw = checkHermes(t, template);
  assert.equal(raw.status, 1);
  assert.match(raw.stderr, /unfilled placeholders/);
});

test("the check rejects a missing provider, a missing model and a tab", (t) => {
  const dropped = checkHermes(t, render(0).replace(/^ {2}tellico-1:$/m, "  other-1:"));
  assert.equal(dropped.status, 1);
  assert.match(dropped.stderr, /provider tellico-1 is missing/);

  const renamed = checkHermes(t, render(0).replace(/qwen3\.8-27b-gsq-iq3s/g, "qwen9"));
  assert.equal(renamed.status, 1);
  assert.match(renamed.stderr, /qwen3\.8-27b-gsq-iq3s is missing/);

  const tabbed = checkHermes(t, render(0).replace("  provider: tellico-0", "\tprovider: tellico-0"));
  assert.equal(tabbed.status, 1);
  assert.match(tabbed.stderr, /contains a tab/);
});

test("the check rejects an empty overlay", (t) => {
  const empty = checkHermes(t, "");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /missing or empty/);
});

test("both rendered nodes fingerprint equal to the template", (t) => {
  // What the drift check compares: one template against two installed
  // copies that legitimately differ by node and endpoint.
  const dir = mkdtempSync(join(tmpdir(), "tellico-hermes-fp-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fingerprints = [join(root, "hermes/config.yaml")];
  for (const node of [0, 1]) {
    const file = join(dir, `node${node}.yaml`);
    writeFileSync(file, render(node));
    fingerprints.push(file);
  }
  const printed = fingerprints.map((file) => {
    const { status, stdout } = sh(`tellico_hermes_fingerprint "${file}"`);
    assert.equal(status, 0);
    return stdout;
  });
  assert.equal(printed[1], printed[0], "node 0 should fingerprint as the template");
  assert.equal(printed[2], printed[0], "node 1 should fingerprint as the template");
});

test("the fingerprint still notices a real edit", (t) => {
  // A normaliser that erased too much would make every drift check pass.
  const dir = mkdtempSync(join(tmpdir(), "tellico-hermes-fp2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const edited = join(dir, "edited.yaml");
  writeFileSync(edited, render(0).replace("reasoning_effort: medium", "reasoning_effort: low"));
  const before = sh(`tellico_hermes_fingerprint "${join(root, "hermes/config.yaml")}"`).stdout;
  const after = sh(`tellico_hermes_fingerprint "${edited}"`).stdout;
  assert.notEqual(after, before);
});

test("the launcher and the overlay are installed and removed together", (t) => {
  const installer = readFileSync(join(root, "install.sh"), "utf8");
  assert.match(installer, /bin\/hermes-tellico/);
  assert.match(installer, /tellico_render_hermes_config/);
  const uninstaller = readFileSync(join(root, "uninstall.sh"), "utf8");
  assert.match(uninstaller, /bin_dir\/hermes-tellico/);
  for (const node of [0, 1]) {
    assert.match(uninstaller, new RegExp(`hermes/node${node}/config\\.yaml`));
  }
  // The user's own Hermes home is theirs; nothing here may write into it.
  for (const [name, text] of [["install.sh", installer], ["uninstall.sh", uninstaller]]) {
    assert.doesNotMatch(text, /\.hermes/, `${name} must not touch the user's Hermes home`);
  }
  const commands = readFileSync(join(root, "lib/checks.sh"), "utf8");
  assert.match(commands, /^hermes-tellico$/m);
});
