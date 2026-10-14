import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
