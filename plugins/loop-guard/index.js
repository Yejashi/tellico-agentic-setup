// Stops a reply that has fallen into a repetition loop, and steers it on.
//
// On this cluster a looping step does not end by itself: it re-emits the same
// paragraph until the 32,768-token output cap, holding one of the four slots
// every user shares for minutes and producing nothing. Measured over 90
// stored sessions (2026-10-14), 16 parts looped like that, most of them in
// workers' reasoning, the worst at 121,709 characters. See detector.js.
//
// The usual cure is a sampler -- DRY or a presence penalty -- and it is the
// wrong one for a coding agent: both penalise reproducing text already in
// the context, and the edit tool works only if the old code is reproduced
// exactly. So sampling is left alone and the loop is handled where it is
// visible, here: when a text or reasoning part starts recycling itself the
// step is interrupted and the session gets one short user message telling it
// to stop deliberating and act. That message also takes the looping
// reasoning out of the model's view: it starts a new turn, and every request
// sends preserve_thinking false (config/opencode.json), so the template drops
// thinking from turns before the latest user message. Without that the
// template keeps all of it -- OpenCode sends every step's reasoning back --
// and a stopped loop stayed in the prompt to be copied (2026-10-14).
// config/opencode.json also caps any one think at 8,192 tokens, so a loop
// this guard misses still ends.
//
// A worker is different. Interrupting it makes its lead's subagent call
// return at once with only "Subagent cancelled", and anything the worker said
// afterwards would reach no one, so the worker is stopped but not steered;
// the note goes to its lead instead, saying why and what to do about it
// (verified on 2.0.26: the lead's call fails with that message and the
// lead's next turn reads the note).
//
// A session gets at most MAX_STEERS notes in STEER_WINDOW_MS without
// progress in between; past that its loops are only stopped, and it waits for
// the user. A tool call that succeeds is progress and clears the count: on
// 2026-10-14 a lead that looped four times in 18 minutes, editing files
// between loops, was stopped silently on the fourth and sat idle until the
// user typed "continue".
//
// The same watch also catches a lead that ends its turn on an announcement
// ("Now let me add the tests.") with no tool call, which leaves the session
// idle while it reads as busy (see stall.js). It is told once to take that
// step; it is nudged again only after it has made progress. A worker is left
// alone: its announcement is its report, and its lead reads it.
//
// On by default; TELLICO_LOOP_GUARD=0 turns both off. OpenCode 1 has no
// plugin context for any of this, so there it is inert.

import { appendFileSync } from "node:fs";
import { LoopDetector } from "./detector.js";
import { announcedStep } from "./stall.js";

const MAX_STEERS = 3;
const STEER_WINDOW_MS = 30 * 60 * 1000;
const SEEN_EVENTS = 4096;

const STEER = [
  "(Tellico loop guard) Your last reply began repeating the same passage, so it was stopped.",
  "Do not restate the plan or weigh the same options again.",
  "Take the next concrete step now with a tool call. If a choice is genuinely open, pick the",
  "most reasonable option, say which in one sentence, and proceed.",
].join(" ");

function stallNote(step) {
  return [
    `(Tellico) Your last reply ended with "${step}" but made no tool call, so the turn ended and`,
    "nothing is running. Take that step now with a tool call. If you are in fact finished, or need",
    "the user to decide something, say that plainly instead.",
  ].join(" ");
}

function workerNote(sessionID, agent) {
  return [
    `(Tellico loop guard) Worker session ${sessionID}${agent ? ` (${agent})` : ""} began repeating the same`,
    "passage in its reply and was stopped, so its task did not finish -- that is why it was cancelled.",
    "Do not send it the same task unchanged. Narrow the task, resume that worker with a sharper",
    `instruction (sessionID ${sessionID}), or do the step yourself.`,
  ].join(" ");
}

function enabled() {
  return !["0", "off", "false", "no"].includes(String(process.env.TELLICO_LOOP_GUARD ?? "").toLowerCase());
}

class Guard {
  constructor() {
    this.locations = new Map();   // directory -> plugin context
    this.watchers = new Map();    // directory -> AbortController
    this.directories = new Map(); // sessionID -> directory
    this.detectors = new Map();   // sessionID|messageID|kind:ordinal -> LoopDetector
    this.stopped = new Set();     // sessions interrupted and not yet restarted
    this.steers = new Map();      // sessionID -> [timestamps]
    this.lastText = new Map();    // sessionID -> text of the current step's last text part
    this.lastFinish = new Map();  // sessionID -> finish reason of its last step
    this.nudged = new Set();      // sessions nudged after a stall, with no progress since
    this.seen = new Set();
    this.seenOrder = [];
    this.trace = process.env.TELLICO_AGENT_TRACE || "";
  }

  record(entry) {
    if (!this.trace.startsWith("/")) return;
    try {
      appendFileSync(this.trace, `${JSON.stringify({ time: new Date().toISOString(), plugin: "loop-guard", ...entry })}\n`);
    } catch { /* A trace failure never touches the session. */ }
  }

  add(context) {
    const dir = context.location?.directory || "";
    this.locations.set(dir, context);
    const controller = new AbortController();
    this.watchers.set(dir, controller);
    (async () => {
      try {
        for await (const ev of context.event.subscribe({ signal: controller.signal })) {
          if (controller.signal.aborted) break;
          try { this.onEvent(ev); } catch { /* Never let one event end the watch. */ }
        }
      } catch { /* Subscription ended: shutting down. */ }
    })();
  }

  remove(context) {
    const dir = context.location?.directory || "";
    this.watchers.get(dir)?.abort();
    this.watchers.delete(dir);
    this.locations.delete(dir);
  }

  contextFor(sessionID) {
    const dir = this.directories.get(sessionID);
    return (dir && this.locations.get(dir)) || this.locations.values().next().value;
  }

  onEvent(ev) {
    if (!ev || typeof ev.type !== "string") return;
    // Every location's subscription carries every location's events.
    if (ev.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      this.seenOrder.push(ev.id);
      if (this.seenOrder.length > SEEN_EVENTS) this.seen.delete(this.seenOrder.shift());
    }
    const data = ev.data || {};
    const sessionID = data.sessionID;
    if (typeof sessionID !== "string") return;
    if (ev.location?.directory) this.directories.set(sessionID, ev.location.directory);

    switch (ev.type) {
      case "session.execution.started":
        this.stopped.delete(sessionID);
        return;
      case "session.step.started":
        this.lastText.delete(sessionID);
        this.lastFinish.delete(sessionID);
        return;
      case "session.step.ended":
        if (typeof data.finish === "string") this.lastFinish.set(sessionID, data.finish);
        return;
      case "session.tool.success":
        // Progress: the loop-note budget and the stall nudge start over.
        this.steers.delete(sessionID);
        this.nudged.delete(sessionID);
        return;
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        for (const key of [...this.detectors.keys()]) {
          if (key.startsWith(`${sessionID}|`)) this.detectors.delete(key);
        }
        const text = this.lastText.get(sessionID);
        const finish = this.lastFinish.get(sessionID);
        this.lastText.delete(sessionID);
        this.lastFinish.delete(sessionID);
        if (ev.type === "session.execution.succeeded" && finish === "stop") this.checkStall(sessionID, text);
        return;
      }
      case "session.text.delta":
      case "session.reasoning.delta": {
        if (this.stopped.has(sessionID) || typeof data.delta !== "string") return;
        const kind = ev.type === "session.text.delta" ? "text" : "reasoning";
        const key = `${sessionID}|${data.assistantMessageID}|${kind}:${data.ordinal ?? 0}`;
        let detector = this.detectors.get(key);
        if (!detector) {
          detector = new LoopDetector();
          this.detectors.set(key, detector);
        }
        if (detector.push(data.delta)) {
          this.detectors.delete(key);
          this.intervene(sessionID, kind, detector.text.length);
        }
        return;
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const kind = ev.type === "session.text.ended" ? "text" : "reasoning";
        if (kind === "text" && typeof data.text === "string") this.lastText.set(sessionID, data.text);
        this.detectors.delete(`${sessionID}|${data.assistantMessageID}|${kind}:${data.ordinal ?? 0}`);
        return;
      }
      default:
    }
  }

  async checkStall(sessionID, text) {
    const step = announcedStep(text);
    if (!step || this.nudged.has(sessionID)) return;
    const context = this.contextFor(sessionID);
    if (!context) return;
    let info = null;
    try { info = await context.session.get({ sessionID }); } catch { return; }
    if (!info || typeof info.parentID === "string") return;
    this.nudged.add(sessionID);
    this.record({ event: "stall_nudged", sessionID, step });
    try {
      await context.session.prompt({ sessionID, text: stallNote(step) });
    } catch (error) {
      this.record({ event: "stall_nudge_failed", sessionID, error: String(error?.message || error).slice(0, 200) });
    }
  }

  async intervene(sessionID, kind, chars) {
    this.stopped.add(sessionID);
    const context = this.contextFor(sessionID);
    if (!context) return;
    let info = null;
    try { info = await context.session.get({ sessionID }); } catch { /* Treat it as a lead. */ }
    const parentID = typeof info?.parentID === "string" ? info.parentID : null;
    try {
      await context.session.interrupt({ sessionID });
    } catch (error) {
      this.record({ event: "loop_interrupt_failed", sessionID, error: String(error?.message || error).slice(0, 200) });
      return;
    }
    // The note goes to whoever can act on it: the session itself, or a
    // worker's lead.
    const target = parentID || sessionID;
    const now = Date.now();
    const recent = (this.steers.get(target) || []).filter(t => now - t < STEER_WINDOW_MS);
    const steer = recent.length < MAX_STEERS;
    this.record({ event: "loop_stopped", sessionID, parentID, part: kind, chars, steer });
    if (!steer) return;
    recent.push(now);
    this.steers.set(target, recent);
    const agent = info?.agent ?? info?.model?.id;
    try {
      await this.contextFor(target).session.prompt({
        sessionID: target,
        text: parentID ? workerNote(sessionID, typeof agent === "string" ? agent : "") : STEER,
      });
    } catch (error) {
      this.record({ event: "loop_steer_failed", sessionID: target, error: String(error?.message || error).slice(0, 200) });
    }
  }
}

let guard = null;

async function setup(context) {
  if (!enabled() || !context?.event?.subscribe || !context?.session?.interrupt) return async () => {};
  guard ??= new Guard();
  const mine = guard;
  try { mine.add(context); } catch { /* A guard that cannot start is no guard, not a broken session. */ }
  return async () => {
    try { mine.remove(context); } catch { /* Shutting down. */ }
    if (mine.locations.size === 0 && guard === mine) guard = null;
  };
}

// OpenCode 1 calls every exported function as a plugin; this one adds nothing.
export const LoopGuardPlugin = async () => ({});

export default { id: "tellico-loop-guard", server: LoopGuardPlugin, setup };
