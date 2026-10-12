import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin, { DispatchBalancePlugin } from "../plugins/dispatch-balance/index.js";

async function fixture(t, background = false, trace = true) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-dispatch-"));
  const keys = ["OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS", "TELLICO_AGENT_TRACE", "TELLICO_LEAD_NODE"];
  const previous = keys.map(key => process.env[key]);
  t.after(() => {
    keys.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(dir, { recursive: true, force: true });
  });
  process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = String(background);
  process.env.TELLICO_LEAD_NODE = "0";
  const path = join(dir, "trace.jsonl");
  if (trace) process.env.TELLICO_AGENT_TRACE = path;
  else delete process.env.TELLICO_AGENT_TRACE;
  return { dir, path, hooks: await DispatchBalancePlugin() };
}

async function before(hooks, callID, args, tool = "task", sessionID = "lead") {
  await hooks["tool.execute.before"]({ sessionID, callID, tool }, { args });
}
async function after(hooks, callID, tool = "task", sessionID = "lead") {
  await hooks["tool.execute.after"]({ sessionID, callID, tool });
}
async function system(hooks, sessionID = "lead") {
  const output = { system: [] };
  await hooks["experimental.chat.system.transform"]({ sessionID }, output);
  return output.system;
}
function records(path) {
  return readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("serial foreground work stays valid without a utilization nudge", async t => {
  const { hooks, path } = await fixture(t);
  for (let i = 0; i < 4; i++) {
    await before(hooks, String(i), { subagent_type: "tellico-worker-1" });
    await after(hooks, String(i));
  }
  const lines = await system(hooks);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /foreground/);
  assert.match(lines[0], /Idle workers are acceptable/);
  assert.equal(records(path).filter(r => r.event === "dispatch_return").length, 4);
});

test("guidance joins the existing system prompt instead of adding a second system message", async t => {
  const { hooks } = await fixture(t);
  await before(hooks, "a", { subagent_type: "tellico-worker-0" });
  await before(hooks, "b", { subagent_type: "tellico-worker-0" });
  const output = { system: ["You are the lead."] };
  await hooks["experimental.chat.system.transform"]({ sessionID: "lead" }, output);
  assert.equal(output.system.length, 1);
  assert.match(output.system[0], /^You are the lead\.\n\nDispatch mode: foreground/);
  assert.match(output.system[0], /concurrent foreground calls/);
});

test("only known simultaneous foreground calls receive a single placement nudge", async t => {
  const { hooks } = await fixture(t);
  await before(hooks, "a", { subagent_type: "tellico-worker-0" });
  await before(hooks, "b", { subagent_type: "tellico-worker-0" });
  const lines = await system(hooks);
  assert.equal(lines.length, 2);
  assert.match(lines[1], /concurrent foreground calls/);
  assert.doesNotMatch(lines[1], /idle|half speed/);
  assert.equal((await system(hooks)).length, 1);
  await before(hooks, "c", { subagent_type: "tellico-worker-0" });
  assert.equal((await system(hooks)).length, 1);
});

test("background acknowledgements are not recorded as worker completions", async t => {
  const { hooks, path } = await fixture(t, true);
  const args = { subagent_type: "tellico-worker-1", background: true, task_id: "previous-worker" };
  await before(hooks, "a", args);
  await before(hooks, "b", args);
  await after(hooks, "a");
  await after(hooks, "b");
  const returns = records(path).filter(r => r.event === "dispatch_return");
  assert.ok(returns.every(r => r.mode === "background" && r.completion_observable === false));
  assert.ok(records(path).find(r => r.resumed === true));
  assert.equal((await system(hooks)).length, 1);
  assert.match((await system(hooks))[0], /acknowledgement, not worker completion/);
});

test("per-call mode overrides enablement and unspecified enabled mode stays unknown", async t => {
  const { hooks, path } = await fixture(t, true);
  await before(hooks, "foreground", { subagent_type: "tellico-worker-0", background: false });
  await after(hooks, "foreground");
  await before(hooks, "unknown", { subagent_type: "tellico-worker-0" });
  await after(hooks, "unknown");
  const returns = records(path).filter(r => r.event === "dispatch_return");
  assert.equal(returns[0].mode, "foreground");
  assert.equal(returns[0].completion_observable, true);
  assert.equal(returns[1].mode, "unknown");
  assert.equal(returns[1].completion_observable, false);
});

test("trace contains metadata only and isolates identical call IDs across sessions", async t => {
  const { hooks, path } = await fixture(t);
  const secret = "PRIVATE-COMMAND-AND-PROMPT";
  await before(hooks, "same", { command: secret, prompt: secret }, "bash", "one");
  await before(hooks, "same", { command: secret }, "bash", "two");
  await after(hooks, "same", "bash", "two");
  await after(hooks, "same", "bash", "one");
  assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(secret));
  const returns = records(path).filter(r => r.event === "tool_return");
  assert.deepEqual(returns.map(r => r.session), ["two", "one"]);
  assert.ok(returns.every(r => r.duration_ms >= 0));
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("disabled trace writes nothing; malformed hook arguments are harmless", async t => {
  const { hooks, dir } = await fixture(t, false, false);
  await hooks["tool.execute.before"]();
  await hooks["tool.execute.after"]();
  await hooks["experimental.chat.system.transform"]();
  await before(hooks, "a", {}, "read");
  await after(hooks, "a", "read");
  assert.throws(() => statSync(join(dir, "trace.jsonl")), { code: "ENOENT" });
});

test("trace failures and symlinks never fail tools or alter a symlink target", async t => {
  const { dir, path } = await fixture(t);
  const target = join(dir, "untouched");
  writeFileSync(target, "original");
  symlinkSync(target, path);
  const hooks = await DispatchBalancePlugin();
  await before(hooks, "a", {}, "read");
  await after(hooks, "a", "read");
  assert.equal(readFileSync(target, "utf8"), "original");
  process.env.TELLICO_AGENT_TRACE = join(dir, "missing-parent", "trace");
  const failed = await DispatchBalancePlugin();
  await before(failed, "b", {}, "read");
  await after(failed, "b", "read");
});

test("OpenCode 2 adapter handles renamed tools, system parts and disposal", async t => {
  const { path } = await fixture(t, true);
  const handlers = {};
  let disposed = 0;
  const register = async (name, fn) => {
    handlers[name] = fn;
    return { dispose() { disposed++; } };
  };
  const dispose = await plugin.setup({ tool: { hook: register }, session: { hook: register } });
  await handlers["execute.before"]({ sessionID: "v2", id: "a", tool: "subagent",
    input: { agent: "tellico-worker-1", background: true } });
  await handlers["execute.after"]({ sessionID: "v2", id: "a", tool: "subagent" });
  const request = { sessionID: "v2", system: [] };
  await handlers.context(request);
  assert.equal(request.system[0].type, "text");
  assert.match(request.system[0].text, /background is enabled/);
  assert.equal(records(path).at(-1).completion_observable, false);
  await dispose();
  assert.equal(disposed, 3);
});
