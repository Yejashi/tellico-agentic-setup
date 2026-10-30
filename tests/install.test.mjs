import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(readFileSync(join(root, "config/opencode.json"), "utf8"));

// OpenCode silently skips a plugin the config names but cannot find, so a
// plugin added to config/opencode.json and not to install.sh would simply
// never run. A fresh install must contain every one of them.
test("a fresh install contains every plugin the config names", t => {
  const home = mkdtempSync(join(tmpdir(), "tellico-install-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const key = join(home, "key");
  writeFileSync(key, "sk-tellico-test\n", { mode: 0o600 });
  const result = spawnSync("sh", [join(root, "install.sh"), "--gateway", "--api-key-file", key, "--no-start"], {
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    input: "",
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr);
  const pluginDir = join(home, ".config/tellico-qwen/plugins");
  const named = config.plugin.map(entry => entry.replace("__TELLICO_PLUGIN_DIR__/", ""));
  assert.ok(named.length >= 6);
  for (const name of named) {
    for (const file of ["index.js", "package.json"]) {
      assert.ok(existsSync(join(pluginDir, name, file)), `${name}/${file} not installed`);
    }
  }
});

// install.sh adds a "tellico" OpenCode instance to t3code's settings. Every
// run here points HOME and T3CODE_HOME into a temporary directory, and a stub
// systemctl keeps uninstall.sh away from the real user's services.
function t3codeHome(t, settings) {
  const home = mkdtempSync(join(tmpdir(), "tellico-t3code-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const t3 = join(home, ".t3");
  if (settings !== undefined) {
    mkdirSync(join(t3, "userdata"), { recursive: true });
    if (settings !== null) writeFileSync(join(t3, "userdata/settings.json"), JSON.stringify(settings));
  }
  const stubs = join(home, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const key = join(home, "key");
  writeFileSync(key, "sk-tellico-test\n", { mode: 0o600 });
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), T3CODE_HOME: t3,
    PATH: stubs + ":" + process.env.PATH };
  const settingsPath = join(t3, "userdata/settings.json");
  return {
    home,
    settingsPath,
    binary: join(home, ".local/bin/opencode-tellico"),
    settings: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    install(args = []) {
      const result = spawnSync("sh", [join(root, "install.sh"), "--gateway", "--api-key-file", key, "--no-start", ...args],
        { env, input: "", encoding: "utf8", timeout: 60000 });
      assert.equal(result.status, 0, result.stderr);
      return result;
    },
    uninstall() {
      const result = spawnSync("sh", [join(root, "uninstall.sh")], { env, input: "", encoding: "utf8", timeout: 60000 });
      assert.equal(result.status, 0, result.stderr);
      return result;
    },
  };
}

test("install adds a Tellico t3code instance and keeps the user's settings and OpenCode instance", t => {
  const f = t3codeHome(t, { idleCompaction: "onReturn", providerInstances: { opencode: { driver: "opencode", enabled: true } } });
  f.install();
  const settings = f.settings();
  assert.equal(settings.idleCompaction, "onReturn");
  assert.deepEqual(settings.providerInstances.opencode, { driver: "opencode", enabled: true });
  assert.deepEqual(settings.providerInstances.tellico, {
    driver: "opencode", displayName: "Tellico", enabled: true,
    environment: [{ name: "TELLICO_T3CODE", value: "1", sensitive: false }],
    config: { binaryPath: f.binary },
  });
  assert.match(readFileSync(join(f.home, ".config/tellico-qwen/client.env"), "utf8"), /^TELLICO_T3CODE_INSTANCE='1'$/m);
});

test("a rerun keeps the user's changes to the instance and does not repeat the variable", t => {
  const f = t3codeHome(t, {});
  f.install();
  const settings = f.settings();
  Object.assign(settings.providerInstances.tellico, { displayName: "Cluster", enabled: false });
  settings.providerInstances.tellico.environment.push({ name: "TELLICO_THINK", value: "low", sensitive: false });
  writeFileSync(f.settingsPath, JSON.stringify(settings));
  f.install();
  const tellico = f.settings().providerInstances.tellico;
  assert.equal(tellico.displayName, "Cluster");
  assert.equal(tellico.enabled, false);
  assert.deepEqual(tellico.environment.map(variable => variable.name).sort(), ["TELLICO_T3CODE", "TELLICO_THINK"]);
});

test("--no-t3code removes the instance and is remembered; --t3code restores it", t => {
  const f = t3codeHome(t, {});
  f.install();
  f.install(["--no-t3code"]);
  assert.equal(f.settings().providerInstances.tellico, undefined);
  f.install();
  assert.equal(f.settings().providerInstances.tellico, undefined);
  f.install(["--t3code"]);
  assert.equal(f.settings().providerInstances.tellico.config.binaryPath, f.binary);
});

test("t3code is left alone until it has been opened, and settings.json is created when missing", t => {
  const unopened = t3codeHome(t);
  unopened.install();
  assert.equal(existsSync(join(unopened.home, ".t3")), false);
  const fresh = t3codeHome(t, null);
  fresh.install();
  assert.equal(fresh.settings().providerInstances.tellico.driver, "opencode");
});

test("a tellico instance of another driver is not overwritten", t => {
  const f = t3codeHome(t, { providerInstances: { tellico: { driver: "codex" } } });
  const { stderr } = f.install();
  assert.match(stderr, /Skipped t3code/);
  assert.deepEqual(f.settings().providerInstances.tellico, { driver: "codex" });
});

test("uninstall removes only an instance that still runs this setup's launcher", t => {
  const ours = t3codeHome(t, { providerInstances: { opencode: { driver: "opencode" } } });
  ours.install();
  ours.uninstall();
  assert.deepEqual(ours.settings().providerInstances, { opencode: { driver: "opencode" } });
  const repointed = t3codeHome(t, {});
  repointed.install();
  const settings = repointed.settings();
  settings.providerInstances.tellico.config.binaryPath = "/opt/other/opencode";
  writeFileSync(repointed.settingsPath, JSON.stringify(settings));
  repointed.uninstall();
  assert.equal(repointed.settings().providerInstances.tellico.config.binaryPath, "/opt/other/opencode");
});
