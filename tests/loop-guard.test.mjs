import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopDetector } from "../plugins/loop-guard/detector.js";
import { announcedStep } from "../plugins/loop-guard/stall.js";
import plugin from "../plugins/loop-guard/index.js";

// Deterministic prose with no repeated 50-character stretch: stands in for a
// model thinking something new.
function novel(chars, seed = 1) {
  const words = ["pane", "tick", "input", "latency", "render", "glyph", "cursor", "buffer", "the", "a",
    "measure", "before", "after", "so", "which", "means", "scroll", "font", "test", "row", "column",
    "frame", "budget", "queue", "flush", "check", "value", "grid", "line", "cell"];
  let x = seed;
  let out = "";
  while (out.length < chars) {
    x = (x * 1103515245 + 12345) % 2147483648;
    out += words[x % words.length] + (x % 7 === 0 ? ". " : " ") + (x % 97);
    out += " ";
  }
  return out.slice(0, chars);
}

function feed(detector, text, size = 9) {
  for (let i = 0; i < text.length; i += size) {
    if (detector.push(text.slice(i, i + size))) return i + size;
  }
  return null;
}

// A 483-character paragraph: a multiple of 7, the period that once slipped past
// a detector that sampled earlier positions every 7 characters.
const PARAGRAPH = ("So the new file should probably be 14-limits.md? But the task explicitly says 12-limits.md. " +
  "Hmm, but 12 is already taken by sources. Let me look at the docs to understand the numbering. " +
  "Maybe the task intends a different number, or maybe it really does want 12-limits.md alongside " +
  "12-sources.md. Hmm. Wait, let me re-read the card once more before deciding anything at all here." +
  " and once more".repeat(20)).slice(0, 482) + " ";

test("a paragraph repeated until the output cap is caught within a few thousand characters", () => {
  assert.equal(PARAGRAPH.length, 483);
  const at = feed(new LoopDetector(), novel(2000) + PARAGRAPH.repeat(250));
  assert.ok(at !== null, "did not fire");
  assert.ok(at < 2000 + 483 * 10, `fired late, at ${at}`);
});

test("an indecision loop in the visible text is caught too", () => {
  const cycle = [
    "Let me update the progress file now, then dispatch the next slice to worker-0.",
    "Let me make the edit to the progress file.",
    "OK, I'm going to stop going back and forth. Let me just: 1. Update the file. 2. Dispatch the slice.",
    "Actually, I should just dispatch the slice now and update the file as part of its commit.",
    "Wait, but the instructions say to update the file before committing, and the commit is done by",
    "worker-0, so I (the lead) update the file and worker-0 commits it. ",
  ].join("\n\n");
  assert.ok(feed(new LoopDetector(), novel(1500) + cycle.repeat(8)) !== null);
});

test("whitespace that varies between repetitions does not hide a loop", () => {
  let text = novel(1500);
  for (let i = 0; i < 20; i++) text += PARAGRAPH.replace(/ /g, i % 2 ? "  " : "\n");
  assert.ok(feed(new LoopDetector(), text) !== null);
});

test("quoting the same code several times amid new analysis is not a loop", () => {
  const code = "fn render(&mut self, frame: &mut Frame) {\n    for row in self.grid.rows() {\n        frame.draw_row(row, self.font);\n    }\n    self.cursor.draw(frame);\n}\n".repeat(3);
  let text = "";
  for (let i = 0; i < 6; i++) text += novel(1600, i + 2) + "\n```rust\n" + code + "```\n";
  assert.equal(feed(new LoopDetector(), text), null);
});

test("long reasoning that keeps saying new things never fires", () => {
  assert.equal(feed(new LoopDetector(), novel(120000, 7)), null);
});

test("nothing short enough to be ordinary fires, and a detector fires once", () => {
  assert.equal(feed(new LoopDetector(), PARAGRAPH.repeat(5)), null);
  const detector = new LoopDetector();
  assert.ok(feed(detector, novel(1500) + PARAGRAPH.repeat(40)) !== null);
  assert.equal(detector.push(PARAGRAPH), false);
});

// --- the plugin, against a fake OpenCode context ----------------------------

function fakeContext(dir, sessions = {}) {
  const calls = [];
  const subscribers = [];
  const context = {
    location: { directory: dir },
    event: {
      subscribe({ signal }) {
        const queue = [];
        let wake = null;
        subscribers.push(ev => { queue.push(ev); wake?.(); });
        return {
          async *[Symbol.asyncIterator]() {
            while (!signal.aborted) {
              if (!queue.length) {
                await new Promise(resolve => {
                  wake = resolve;
                  signal.addEventListener("abort", resolve, { once: true });
                });
                wake = null;
                continue;
              }
              yield queue.shift();
            }
          },
        };
      },
    },
    session: {
      async get({ sessionID }) { calls.push(["get", sessionID]); return sessions[sessionID] ?? { id: sessionID }; },
      async interrupt(args) { calls.push(["interrupt", args.sessionID]); return { interrupted: true }; },
      async prompt(args) { calls.push(["prompt", args.sessionID, args.text]); return { id: "msg_x" }; },
    },
  };
  return { context, calls, emit: ev => subscribers.forEach(push => push(ev)) };
}

let eventId = 0;
function stream(emit, sessionID, text, { kind = "reasoning", message = "msg_a", size = 40 } = {}) {
  for (let i = 0; i < text.length; i += size) {
    emit({ id: `evt_${++eventId}`, type: `session.${kind}.delta`, location: { directory: "/p" },
      data: { sessionID, assistantMessageID: message, ordinal: 0, delta: text.slice(i, i + size) } });
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));
const LOOP = novel(1500) + PARAGRAPH.repeat(30);

async function withGuard(t, sessions, env = {}) {
  const saved = process.env.TELLICO_LOOP_GUARD;
  if ("TELLICO_LOOP_GUARD" in env) process.env.TELLICO_LOOP_GUARD = env.TELLICO_LOOP_GUARD;
  else delete process.env.TELLICO_LOOP_GUARD;
  const fake = fakeContext("/p", sessions);
  const dispose = await plugin.setup(fake.context);
  t.after(async () => {
    await dispose();
    if (saved === undefined) delete process.env.TELLICO_LOOP_GUARD;
    else process.env.TELLICO_LOOP_GUARD = saved;
  });
  return fake;
}

test("a looping lead is stopped and told to act", async t => {
  const fake = await withGuard(t, {});
  stream(fake.emit, "ses_lead", LOOP);
  await settle();
  const actions = fake.calls.filter(([name]) => name !== "get");
  assert.deepEqual(actions.map(([name, id]) => [name, id]), [["interrupt", "ses_lead"], ["prompt", "ses_lead"]]);
  assert.match(actions[1][2], /loop guard/);
  assert.match(actions[1][2], /tool call/);
});

test("a looping worker is stopped and its lead is told why, not the worker", async t => {
  const fake = await withGuard(t, { ses_worker: { id: "ses_worker", parentID: "ses_lead", agent: "tellico-worker-0" } });
  stream(fake.emit, "ses_worker", LOOP);
  await settle();
  const actions = fake.calls.filter(([name]) => name !== "get");
  assert.deepEqual(actions.map(([name, id]) => [name, id]), [["interrupt", "ses_worker"], ["prompt", "ses_lead"]]);
  assert.match(actions[1][2], /ses_worker/);
  assert.match(actions[1][2], /tellico-worker-0/);
  assert.match(actions[1][2], /Do not send it the same task unchanged/);
});

test("a session that keeps looping is steered three times, then only stopped", async t => {
  const fake = await withGuard(t, {});
  for (let i = 0; i < 5; i++) {
    stream(fake.emit, "ses_lead", LOOP, { message: `msg_${i}` });
    await settle();
    fake.emit({ id: `evt_${++eventId}`, type: "session.execution.started", data: { sessionID: "ses_lead" } });
    await settle();
  }
  assert.equal(fake.calls.filter(([name]) => name === "interrupt").length, 5);
  assert.equal(fake.calls.filter(([name]) => name === "prompt").length, 3);
});

test("ordinary output, a finished part and a repeated event never trigger it", async t => {
  const fake = await withGuard(t, {});
  stream(fake.emit, "ses_a", novel(40000, 3), { kind: "text" });
  // Half a loop, then the part ends: its detector goes with it.
  stream(fake.emit, "ses_b", LOOP.slice(0, 2500));
  fake.emit({ id: `evt_${++eventId}`, type: "session.reasoning.ended", data: { sessionID: "ses_b", assistantMessageID: "msg_a", ordinal: 0 } });
  stream(fake.emit, "ses_b", PARAGRAPH.repeat(3), { message: "msg_b" });
  // The same event twice, as two locations' subscriptions would deliver it.
  const ev = { id: "evt_dup", type: "session.text.delta", data: { sessionID: "ses_c", assistantMessageID: "m", ordinal: 0, delta: "x" } };
  fake.emit(ev);
  fake.emit(ev);
  await settle();
  assert.deepEqual(fake.calls, []);
});

test("TELLICO_LOOP_GUARD=0 turns it off entirely", async t => {
  const fake = await withGuard(t, {}, { TELLICO_LOOP_GUARD: "0" });
  stream(fake.emit, "ses_lead", LOOP);
  await settle();
  assert.deepEqual(fake.calls, []);
});

test("a session that makes progress between loops gets a note every time", async t => {
  const fake = await withGuard(t, {});
  for (let i = 0; i < 5; i++) {
    stream(fake.emit, "ses_lead", LOOP, { message: `msg_${i}` });
    await settle();
    fake.emit({ id: `evt_${++eventId}`, type: "session.execution.started", data: { sessionID: "ses_lead" } });
    fake.emit({ id: `evt_${++eventId}`, type: "session.tool.success", data: { sessionID: "ses_lead", id: `call_${i}` } });
    await settle();
  }
  assert.equal(fake.calls.filter(([name]) => name === "prompt").length, 5);
});

// --- a turn that ends on an announced step -----------------------------------

test("the announced-but-not-taken endings seen in stored sessions are recognised", () => {
  for (const text of [
    "§474§ Now let me add the N34a format conversion tests to the test file.",
    "Let me run the git commands to inspect the repository.",
    "Let me construct the git commands and execute them using the Bash tool.",
    "Let me write the updated README.md:",
    "I will generate the poem now.",
    "The build is clean.\n\n**Next,** I'll wire the parser into the renderer.",
  ]) assert.ok(announcedStep(text), text);
});

test("finished answers, questions and waits on other work are not stalls", () => {
  for (const text of [
    "N33b is complete and verified. I've updated `PROGRESS.md` and committed it.",
    "Let me know if you'd like me to proceed with the N14 readiness spike.",
    "Should I also update the README?",
    "I'll confirm the commit and push once the completion report arrives.",
    "I'll continue as soon as the N15 spike reports back.",
    "Awaiting the background gate result. I'll proceed to the live legs and commit once it reports.",
    "I'll pick up automatically when the integration report lands.",
    "Let me run the tests.\n\nAll 503 tests pass and clippy is clean.",
    "",
  ]) assert.equal(announcedStep(text), "", text);
  assert.equal(announcedStep(undefined), "");
});

function endTurn(emit, sessionID, text, finish = "stop") {
  const ev = (type, data) => emit({ id: `evt_${++eventId}`, type, data: { sessionID, ...data } });
  ev("session.step.started", { assistantMessageID: "msg_s" });
  ev("session.text.ended", { assistantMessageID: "msg_s", ordinal: 0, text });
  ev("session.step.ended", { assistantMessageID: "msg_s", finish });
  if (finish === "stop") ev("session.execution.succeeded", {});
}

test("a lead that ends its turn on an announced step is told to take it, once until it makes progress", async t => {
  const fake = await withGuard(t, {});
  endTurn(fake.emit, "ses_lead", "Now let me add the N34a format conversion tests to the test file.");
  await settle();
  const prompts = fake.calls.filter(([name]) => name === "prompt");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0][1], "ses_lead");
  assert.match(prompts[0][2], /Now let me add the N34a format conversion tests/);
  assert.match(prompts[0][2], /no tool call/);
  // It stalls again straight away: no second nudge.
  endTurn(fake.emit, "ses_lead", "Let me add the tests now.");
  await settle();
  assert.equal(fake.calls.filter(([name]) => name === "prompt").length, 1);
  // After real progress it can be nudged again.
  fake.emit({ id: `evt_${++eventId}`, type: "session.tool.success", data: { sessionID: "ses_lead", id: "call_1" } });
  endTurn(fake.emit, "ses_lead", "Let me add the tests now.");
  await settle();
  assert.equal(fake.calls.filter(([name]) => name === "prompt").length, 2);
});

test("a worker, a finished turn, a tool-call step and an interrupted turn are never nudged", async t => {
  const fake = await withGuard(t, { ses_worker: { id: "ses_worker", parentID: "ses_lead" } });
  endTurn(fake.emit, "ses_worker", "Let me add the tests now.");
  endTurn(fake.emit, "ses_a", "All tests pass; the feature is committed and pushed.");
  endTurn(fake.emit, "ses_b", "Let me add the tests now.", "tool-calls");
  fake.emit({ id: `evt_${++eventId}`, type: "session.step.started", data: { sessionID: "ses_c" } });
  fake.emit({ id: `evt_${++eventId}`, type: "session.text.ended", data: { sessionID: "ses_c", ordinal: 0, text: "Let me add the tests now." } });
  fake.emit({ id: `evt_${++eventId}`, type: "session.execution.interrupted", data: { sessionID: "ses_c", reason: "user" } });
  await settle();
  assert.deepEqual(fake.calls.filter(([name]) => name !== "get"), []);
});
