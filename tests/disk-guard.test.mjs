import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { DiskGuardPlugin } from "../plugins/disk-guard/index.js";

// TELLICO_DISK_MIN_FREE makes a roomy test disk look full; unset, the real
// 64 MiB floor applies and an ordinary write passes.
async function withFloor(t, value) {
  const saved = process.env.TELLICO_DISK_MIN_FREE;
  if (value === undefined) delete process.env.TELLICO_DISK_MIN_FREE;
  else process.env.TELLICO_DISK_MIN_FREE = String(value);
  t.after(() => {
    if (saved === undefined) delete process.env.TELLICO_DISK_MIN_FREE;
    else process.env.TELLICO_DISK_MIN_FREE = saved;
  });
}

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-disk-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function v2Hook() {
  let handler;
  await plugin.setup({ tool: { hook: async (name, fn) => { assert.equal(name, "execute.before"); handler = fn; return { dispose() {} }; } } });
  return (tool, input) => handler({ tool, input });
}

async function v1Hook() {
  const hooks = await DiskGuardPlugin();
  return (tool, args) => hooks["tool.execute.before"]({ tool }, { args });
}

const FULL = 1e18;

for (const [name, make] of [["OpenCode 2", v2Hook], ["OpenCode 1", v1Hook]]) {
  test(`${name}: a write to a full disk is refused with the reason, before any file exists`, async t => {
    await withFloor(t, FULL);
    const run = await make();
    const dir = workspace(t);
    // v2 spells it path, v1 filePath; both are covered.
    for (const args of [{ path: join(dir, "a.md"), content: "x" }, { filePath: join(dir, "b.md"), content: "x" }]) {
      await assert.rejects(async () => run("write", args), error => {
        assert.match(error.message, /\[disk-guard\] not written/);
        assert.match(error.message, /free/);
        assert.match(error.message, /not a fault in the write tool/);
        return true;
      });
    }
  });

  test(`${name}: edits are covered, and other tools are not touched`, async t => {
    await withFloor(t, FULL);
    const run = await make();
    const dir = workspace(t);
    await assert.rejects(async () => run("edit", { path: join(dir, "a.rs"), oldString: "a", newString: "b" }));
    await run("read", { path: join(dir, "a.rs") });
    await run("shell", { command: "df -h" });
    await run("glob", { pattern: "*" });
  });
}

test("an ordinary write on a disk with room passes", async t => {
  await withFloor(t, undefined);
  const run = await v2Hook();
  await run("write", { path: join(workspace(t), "notes.md"), content: "# hello\n" });
});

test("a file in directories that do not exist yet is measured at its nearest existing ancestor", async t => {
  await withFloor(t, FULL);
  const run = await v2Hook();
  await assert.rejects(async () => run("write", { path: join(workspace(t), "new/deeper/file.md"), content: "x" }),
    /\[disk-guard\]/);
});

test("anything it cannot judge is let through", async t => {
  await withFloor(t, FULL);
  const run = await v2Hook();
  await run("write", {});
  await run("write", { path: 42, content: "x" });
  await run("write", null);
});
