import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coalesce, snapshotFromHistory, summarizeTool, translateEvent } from "../plugins/remote-control/protocol.js";
import plugin from "../plugins/remote-control/index.js";
import { applyOp, createState, exportTranscript, loadTranscript } from "../relay/web/reducer.js";

const root = fileURLToPath(new URL("../", import.meta.url));
// Recorded from a real OpenCode 2.0.26 server: text turns, a tool refused by
// permission, a tool that succeeded, and a generation interrupted mid-stream.
const events = readFileSync(join(root, "tests/fixtures/opencode2-events.jsonl"), "utf8")
  .trim().split("\n").map(line => JSON.parse(line));
const { info, history } = JSON.parse(readFileSync(join(root, "tests/fixtures/opencode2-history.json"), "utf8"));
const conformance = JSON.parse(readFileSync(join(root, "tests/fixtures/relay-ops.json"), "utf8"));

function opsFor(type) {
  const ev = events.find(e => e.type === type);
  assert.ok(ev, `fixture has ${type}`);
  return translateEvent(ev).ops;
}

test("a user prompt keeps the id OpenCode gives it, so history and live agree", () => {
  const ev = events.find(e => e.type === "session.inbox.enqueued");
  const [message] = translateEvent(ev).ops.filter(op => op.op === "message");
  assert.equal(message.message.id, ev.data.inboxID);
  assert.equal(message.message.role, "user");
  assert.equal(message.message.text, ev.data.item.payload.text);
});

test("streamed text and reasoning are keyed by kind and per-kind ordinal", () => {
  const [text] = opsFor("session.text.delta");
  assert.deepEqual([text.op, text.key, text.kind], ["append", "text:0", "text"]);
  const [reasoning] = opsFor("session.reasoning.delta");
  assert.deepEqual([reasoning.key, reasoning.kind], ["reasoning:0", "reasoning"]);
  // The ended event carries the whole text, which repairs any duplicate a
  // late join may have streamed.
  const [ended] = opsFor("session.text.ended");
  assert.equal(ended.part.done, true);
  assert.equal(typeof ended.part.text, "string");
});

test("tool calls run from called to done or error, keyed by call id", () => {
  const called = events.find(e => e.type === "session.tool.called");
  const [running] = translateEvent(called).ops;
  assert.equal(running.part.key, `tool:${called.data.id}`);
  assert.equal(running.part.status, "running");
  assert.ok(running.part.summary);

  const [done] = opsFor("session.tool.success");
  assert.equal(done.part.status, "done");
  assert.match(done.part.output, /a\.txt/);

  const [failed] = opsFor("session.tool.failed");
  assert.equal(failed.part.status, "error");
  assert.match(failed.part.error, /Permission denied/);
});

test("execution events become session status, including an interrupt", () => {
  const status = type => opsFor(type).find(op => op.op === "status").status;
  assert.equal(status("session.execution.started"), "running");
  assert.equal(status("session.execution.succeeded"), "idle");
  assert.equal(status("session.execution.interrupted"), "interrupted");
});

test("events that name no session are ignored, and unknown session events still count as activity", () => {
  assert.equal(translateEvent({ type: "agent.updated", data: {} }), null);
  assert.equal(translateEvent(null), null);
  const { ops } = translateEvent({ type: "session.something.new", created: 5, data: { sessionID: "ses_x" } });
  assert.deepEqual(ops, [{ op: "session", sessionID: "ses_x", session: { updated: 5 } }]);
});

test("history becomes one snapshot with the same keys the live stream uses", () => {
  const snapshot = snapshotFromHistory(info, history, "idle");
  assert.equal(snapshot.op, "snapshot");
  assert.equal(snapshot.sessionID, info.id);
  assert.equal(snapshot.session.status, "idle");
  assert.equal(snapshot.session.directory, "/home/user/project");
  const roles = snapshot.messages.map(m => m.role);
  assert.ok(roles.includes("user") && roles.includes("assistant"));
  // "idle" markers in the history are bookkeeping, not messages.
  assert.equal(history.filter(m => m.type === "idle").length > 0, true);
  assert.equal(snapshot.messages.length, history.filter(m => m.type !== "idle").length);
  const parts = snapshot.messages.flatMap(m => m.parts || []);
  const glob = parts.find(p => p.tool === "glob");
  assert.equal(glob.status, "done");
  assert.match(glob.output, /a\.txt/);
  assert.ok(parts.some(p => p.kind === "tool" && p.status === "error"));
  assert.ok(parts.some(p => p.key === "text:0" && p.done));
  assert.ok(parts.some(p => p.key === "reasoning:0"));
});

test("only adjacent appends to the same part are merged", () => {
  const a = { op: "append", sessionID: "s", messageID: "m", key: "text:0", kind: "text" };
  const merged = coalesce([{ ...a, text: "he" }, { ...a, text: "llo" }, { op: "status", sessionID: "s", status: "idle" }, { ...a, text: "!" }]);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].text, "hello");
  assert.equal(merged[2].text, "!");
});

test("a tool row shows the command, the file or the question, not raw JSON", () => {
  assert.equal(summarizeTool("shell", { command: "npm test\nnpm run lint" }), "npm test");
  assert.equal(summarizeTool("read", { filePath: "/x/y.js" }), "/x/y.js");
  assert.equal(summarizeTool("question", { questions: [{ question: "Proceed?" }] }), "Proceed?");
  assert.equal(summarizeTool("glob", { pattern: "*" }), "*");
});

test("the phone's reducer reaches exactly the relay's state from the relay's ops", () => {
  const state = createState();
  for (const sid of Object.keys(conformance.expected)) loadTranscript(state, sid, { messages: [] });
  for (const op of conformance.normalized) applyOp(state, op);
  for (const [sid, expected] of Object.entries(conformance.expected)) {
    assert.deepEqual(exportTranscript(state, sid), expected.messages, sid);
    assert.equal(state.sessions.get(sid).status, expected.meta.status);
  }
});

// --- the connector, against a fake OpenCode context and a fake relay ----------

function fakeContext(dir, script) {
  const calls = [];
  let push;
  const queue = [...script];
  return {
    calls,
    emit(ev) { push?.(ev); },
    context: {
      app: { version: "2.0.26-test" },
      location: { directory: dir },
      event: {
        subscribe({ signal }) {
          return {
            async *[Symbol.asyncIterator]() {
              while (!signal.aborted) {
                const next = queue.shift() ?? await new Promise(resolve => {
                  push = resolve;
                  signal.addEventListener("abort", () => resolve(null), { once: true });
                });
                if (next) yield next;
              }
            },
          };
        },
      },
      session: {
        async get({ sessionID }) { calls.push(["get", sessionID]); return { ...info, id: sessionID }; },
        async context({ sessionID }) { calls.push(["context", sessionID]); return history; },
        async prompt(args) { calls.push(["prompt", args]); return { id: "msg_x" }; },
        async interrupt(args) { calls.push(["interrupt", args]); return { interrupted: true }; },
      },
    },
  };
}

function fakeRelay(commands) {
  const seen = { publish: [], poll: [], bye: 0, auth: new Set() };
  const pending = [...commands];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    seen.auth.add(init.headers.authorization);
    const body = JSON.parse(init.body);
    const reply = payload => ({ ok: true, status: 200, json: async () => payload });
    if (path.endsWith("/agent/publish")) {
      seen.publish.push(body);
      return reply({ epoch: "e1", resync: false });
    }
    if (path.endsWith("/agent/poll")) {
      seen.poll.push(body);
      await new Promise(resolve => setTimeout(resolve, 20));
      return reply({ epoch: "e1", resync: false, commands: pending.splice(0) });
    }
    if (path.endsWith("/agent/bye")) {
      seen.bye++;
      return reply({ epoch: "e1" });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { seen, fetchImpl };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return false;
};

function keyFile(t) {
  const dir = mkdtempSync(join(tmpdir(), "tellico-rc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "api-key");
  writeFileSync(path, "sk-tellico-test\n", { mode: 0o600 });
  return path;
}

test("without TELLICO_REMOTE_CONTROL=1 the plugin does nothing at all", async t => {
  const relay = fakeRelay([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = relay.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  await withEnv({ TELLICO_REMOTE_CONTROL: undefined, TELLICO_RELAY_URL: "http://127.0.0.1:1/tellico", TELLICO_RELAY_KEY_FILE: keyFile(t) }, async () => {
    const fake = fakeContext("/p", events.slice(0, 5));
    const dispose = await plugin.setup(fake.context);
    await new Promise(resolve => setTimeout(resolve, 100));
    await dispose();
    assert.equal(relay.seen.publish.length + relay.seen.poll.length, 0);
    assert.equal(fake.calls.length, 0);
  });
});

test("the key is never sent to a relay in the clear", async t => {
  const relay = fakeRelay([]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = relay.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  await withEnv({ TELLICO_REMOTE_CONTROL: "1", TELLICO_RELAY_URL: "http://relay.example/tellico", TELLICO_RELAY_KEY_FILE: keyFile(t) }, async () => {
    const dispose = await plugin.setup(fakeContext("/p", events.slice(0, 5)).context);
    await new Promise(resolve => setTimeout(resolve, 100));
    await dispose();
    assert.equal(relay.seen.publish.length + relay.seen.poll.length, 0);
  });
});

test("it publishes sessions with their history, then runs only the commands it should", async t => {
  const sid = events.find(e => e.type === "session.inbox.enqueued").data.sessionID;
  const relay = fakeRelay([
    { id: "cmd_1", type: "prompt", sessionID: sid, text: "from the phone" },
    { id: "cmd_2", type: "interrupt", sessionID: sid },
    { id: "cmd_3", type: "prompt", sessionID: "ses_notmine", text: "hijack" },
    { id: "cmd_4", type: "shell", sessionID: sid, text: "rm -rf /" },
    { id: "cmd_5", type: "prompt", sessionID: sid, text: "   " },
  ]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = relay.fetchImpl;
  t.after(() => { globalThis.fetch = realFetch; });
  await withEnv({ TELLICO_REMOTE_CONTROL: "1", TELLICO_RELAY_URL: "http://127.0.0.1:9/tellico", TELLICO_RELAY_KEY_FILE: keyFile(t), TELLICO_RELAY_MACHINE: "test-box" }, async () => {
    const fake = fakeContext("/home/user/project", events);
    const dispose = await plugin.setup(fake.context);
    try {
      // Every op reaches the relay, the first sighting of a session brings its
      // history along, and the host says which machine and window it is.
      assert.ok(await until(() => relay.seen.publish.flatMap(p => p.ops).some(op => op.op === "snapshot")));
      const first = relay.seen.publish[0];
      assert.equal(first.host.machine, "test-box");
      assert.equal(first.host.kind, "server");
      assert.equal(first.host.version, "2.0.26-test");
      assert.ok(fake.calls.some(([name, id]) => name === "context" && id === sid));
      assert.deepEqual([...relay.seen.auth], ["Bearer sk-tellico-test"]);

      // Commands: a prompt and an interrupt for its own session run; nothing
      // else does.
      assert.ok(await until(() => relay.seen.poll.flatMap(p => p.results).length >= 5));
      const results = Object.fromEntries(relay.seen.poll.flatMap(p => p.results).map(r => [r.id, r]));
      assert.equal(results.cmd_1.ok, true);
      assert.equal(results.cmd_2.ok, true);
      assert.equal(results.cmd_3.ok, false);
      assert.match(results.cmd_3.error, /not running in this process/);
      assert.equal(results.cmd_4.ok, false);
      assert.equal(results.cmd_5.ok, false);
      assert.deepEqual(fake.calls.filter(([name]) => name === "prompt" || name === "interrupt"), [
        ["prompt", { sessionID: sid, text: "from the phone" }],
        ["interrupt", { sessionID: sid }],
      ]);
    } finally {
      await dispose();
    }
    assert.ok(await until(() => relay.seen.bye === 1));
  });
});
