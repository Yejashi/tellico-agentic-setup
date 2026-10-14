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
// On by default; TELLICO_LOOP_GUARD=0 turns it off. A session gets at most
// MAX_STEERS notes in STEER_WINDOW_MS; past that its loops are only stopped,
// and it waits for the user. OpenCode 1 has no plugin context for any of
// this, so there it is inert.

import { appendFileSync } from "node:fs";
import { LoopDetector } from "./detector.js";

const MAX_STEERS = 3;
const STEER_WINDOW_MS = 30 * 60 * 1000;
const SEEN_EVENTS = 4096;

const STEER = [
  "(Tellico loop guard) Your last reply began repeating the same passage, so it was stopped.",
  "Do not restate the plan or weigh the same options again.",
  "Take the next concrete step now with a tool call. If a choice is genuinely open, pick the",
  "most reasonable option, say which in one sentence, and proceed.",
].join(" ");

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
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        for (const key of [...this.detectors.keys()]) {
          if (key.startsWith(`${sessionID}|`)) this.detectors.delete(key);
        }
        return;
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
        this.detectors.delete(`${sessionID}|${data.assistantMessageID}|${kind}:${data.ordinal ?? 0}`);
        return;
      }
      default:
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
