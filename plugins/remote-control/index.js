// Publishes this OpenCode process's sessions to the Tellico relay, and runs the
// prompts and stops a phone sends back -- the "remote control" half of the
// relay. See relay/README.md.
//
// Off unless the launcher says otherwise: it does nothing at all without
// TELLICO_REMOTE_CONTROL=1, which opencode-tellico sets only on a device that
// opted in (install.sh --remote-control) or for one launch (--remote-control).
// Every install carries the plugin, so turning it on needs no reinstall.
//
// What it can do on this machine is deliberately narrow. The relay can ask for
// exactly two things -- send a prompt to a session, or interrupt one -- and
// only for sessions this process is running. It never reads files, opens a
// shell or touches config on the relay's behalf; the agents do what they would
// have done had the prompt been typed here.
//
// It sees sessions from the inside, through OpenCode 2's plugin context: the
// event stream for live output, session.context for history, session.prompt
// and session.interrupt for the two commands. That is why no port on this
// machine is opened or forwarded -- both directions are requests it makes out
// to the relay, authenticated with the user's own gateway key.
//
// OpenCode 1 has none of that context, so there it is inert.

import { appendFileSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { coalesce, snapshotFromHistory, translateEvent } from "./protocol.js";

const FLUSH_MS = 120;
const POLL_WAIT_S = 25;
const MAX_QUEUE = 5000;
const SEEN_EVENTS = 4096;

function config() {
  if (process.env.TELLICO_REMOTE_CONTROL !== "1") return null;
  const url = (process.env.TELLICO_RELAY_URL || "").replace(/\/+$/, "");
  const keyFile = process.env.TELLICO_RELAY_KEY_FILE || "";
  if (!url || !keyFile) return null;
  // The key rides on every request, so it never goes anywhere in the clear.
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !loopback) return null;
  const argv = process.argv.join(" ");
  const kind = /\s--stdio(\s|$)/.test(argv) ? "tui"
    : process.env.OPENCODE_CALLER === "vscode" ? "vscode"
    : "server";
  return {
    url,
    keyFile,
    debug: process.env.TELLICO_RELAY_DEBUG || "",
    host: {
      id: randomUUID(),
      machine: (process.env.TELLICO_RELAY_MACHINE || hostname() || "machine").slice(0, 64),
      kind,
      pid: process.pid,
      started: Date.now(),
    },
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Connector {
  constructor(cfg) {
    this.cfg = cfg;
    this.locations = new Map();      // directory -> plugin context
    this.watchers = new Map();       // directory -> AbortController
    this.sessions = new Map();       // sessionID -> { dir, state, buffer }
    this.seen = new Set();
    this.seenOrder = [];
    this.pending = [];
    this.timer = null;
    this.publishing = false;
    this.epoch = null;
    this.results = [];
    this.stopped = false;
    this.started = false;
    this.backoff = 1000;
    this.key = null;
    this.warned = new Set();
  }

  log(message, detail) {
    if (!this.cfg.debug) return;
    try {
      appendFileSync(this.cfg.debug, `${new Date().toISOString()} ${message}${detail ? ` ${String(detail).slice(0, 500)}` : ""}\n`);
    } catch { /* Debug logging must never break a session. */ }
  }

  // Once per failure kind, so a relay that is down does not fill the log.
  warn(kind, detail) {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    this.log(`warn ${kind}`, detail);
  }

  readKey() {
    try {
      this.key = readFileSync(this.cfg.keyFile, "utf8").trim();
    } catch (error) {
      this.key = null;
      this.warn("key", error);
    }
    return this.key;
  }

  addLocation(context) {
    const dir = context.location?.directory || "";
    this.locations.set(dir, context);
    if (context.app?.version) this.cfg.host.version = String(context.app.version);
    this.watch(dir, context);
    if (!this.started) {
      this.started = true;
      this.pollLoop();
    }
  }

  removeLocation(context) {
    const dir = context.location?.directory || "";
    this.watchers.get(dir)?.abort();
    this.watchers.delete(dir);
    this.locations.delete(dir);
    if (this.locations.size === 0) this.stop();
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const controller of this.watchers.values()) controller.abort();
    this.pollController?.abort();
    clearTimeout(this.timer);
    // Best effort: the relay marks the host offline on its own after a short
    // silence, so a lost goodbye costs only those seconds.
    this.request("/agent/bye", { host: this.cfg.host }).catch(() => {});
  }

  // Each location's subscription carries every location's events, so they are
  // de-duplicated by event id rather than filtered by directory: some events,
  // such as session.execution.succeeded, carry no location at all.
  async watch(dir, context) {
    const controller = new AbortController();
    this.watchers.set(dir, controller);
    try {
      for await (const ev of context.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        try { this.onEvent(ev); } catch (error) { this.warn("event", error); }
      }
    } catch (error) {
      if (!controller.signal.aborted) this.warn("subscribe", error);
    }
  }

  onEvent(ev) {
    if (ev?.id) {
      if (this.seen.has(ev.id)) return;
      this.seen.add(ev.id);
      this.seenOrder.push(ev.id);
      if (this.seenOrder.length > SEEN_EVENTS) this.seen.delete(this.seenOrder.shift());
    }
    const translated = translateEvent(ev);
    if (!translated) return;
    const { sessionID, directory, ops } = translated;
    let session = this.sessions.get(sessionID);
    if (!session) {
      session = { dir: directory ?? null, state: "new", buffer: [] };
      this.sessions.set(sessionID, session);
      this.sync(sessionID, ev.type === "session.execution.started" ? "running" : undefined);
    }
    if (directory) session.dir = directory;
    if (session.state === "syncing") session.buffer.push(...ops);
    else this.queue(ops);
  }

  contextFor(dir) {
    return (dir && this.locations.get(dir)) || this.locations.values().next().value;
  }

  // History first, then whatever streamed while it was being read. A part
  // that both cover is repaired by its *.ended event, which carries the full
  // text.
  async sync(sessionID, status) {
    const session = this.sessions.get(sessionID);
    if (!session) return;
    session.state = "syncing";
    try {
      const context = this.contextFor(session.dir);
      const info = await context.session.get({ sessionID });
      const history = await context.session.context({ sessionID });
      if (info?.location?.directory) session.dir = info.location.directory;
      const snapshot = snapshotFromHistory(info, history, status);
      if (snapshot) this.queue([snapshot]);
    } catch (error) {
      this.warn("sync", error);
    }
    session.state = "live";
    const buffered = session.buffer;
    session.buffer = [];
    this.queue(buffered);
  }

  resync() {
    this.log("resync", `${this.sessions.size} sessions`);
    for (const [sessionID, session] of this.sessions) {
      if (session.state !== "syncing") this.sync(sessionID);
    }
  }

  queue(ops) {
    if (!ops.length) return;
    this.pending.push(...ops);
    if (this.pending.length > MAX_QUEUE) {
      // The relay has been unreachable for a long while. Rather than send a
      // stale backlog, drop it and send each session whole when it returns.
      this.pending = [];
      this.overflowed = true;
      this.warn("overflow");
    }
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  async flush() {
    this.timer = null;
    if (this.stopped) return;
    if (this.publishing) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      return;
    }
    const ops = coalesce(this.pending.splice(0));
    if (!ops.length) return;
    this.publishing = true;
    try {
      const reply = await this.request("/agent/publish", { v: 1, host: this.cfg.host, epoch: this.epoch, ops });
      this.backoff = 1000;
      this.onReply(reply);
      if (this.overflowed) {
        this.overflowed = false;
        this.resync();
      }
    } catch (error) {
      this.warn(`publish ${error.status || ""}`, error);
      this.pending.unshift(...ops);
      if (this.pending.length > MAX_QUEUE) {
        this.pending = [];
        this.overflowed = true;
      }
      await sleep(this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
    } finally {
      this.publishing = false;
    }
  }

  onReply(reply) {
    if (!reply || typeof reply.epoch !== "string") return;
    const restarted = this.epoch !== null && this.epoch !== reply.epoch;
    this.epoch = reply.epoch;
    if (restarted || reply.resync) this.resync();
  }

  // One long-poll does three jobs: it keeps this host marked online, carries
  // the results of the last commands back, and brings the next ones.
  async pollLoop() {
    while (!this.stopped) {
      this.pollController = new AbortController();
      try {
        const results = this.results.splice(0);
        const reply = await this.request(
          "/agent/poll",
          { v: 1, host: this.cfg.host, epoch: this.epoch, results, wait: POLL_WAIT_S },
          this.pollController.signal,
          (POLL_WAIT_S + 15) * 1000,
        );
        this.backoff = 1000;
        this.onReply(reply);
        for (const command of Array.isArray(reply?.commands) ? reply.commands : []) {
          this.results.push(await this.run(command));
        }
      } catch (error) {
        if (this.stopped) break;
        this.warn(`poll ${error.status || ""}`, error);
        await sleep(this.backoff);
        this.backoff = Math.min(this.backoff * 2, 60000);
      }
    }
  }

  async run(command) {
    const id = String(command?.id ?? "");
    try {
      const sessionID = command?.sessionID;
      const session = this.sessions.get(sessionID);
      if (!session) return { id, ok: false, error: "That session is not running in this process." };
      const context = this.contextFor(session.dir);
      if (command.type === "prompt") {
        const text = String(command.text ?? "").slice(0, 64000);
        if (!text.trim()) return { id, ok: false, error: "Empty prompt." };
        await context.session.prompt({ sessionID, text });
      } else if (command.type === "interrupt") {
        await context.session.interrupt({ sessionID });
      } else {
        return { id, ok: false, error: "Unknown command." };
      }
      this.log(`ran ${command.type}`, sessionID);
      return { id, ok: true };
    } catch (error) {
      this.warn("command", error);
      return { id, ok: false, error: String(error?.message || error).slice(0, 300) };
    }
  }

  async request(path, body, signal, timeoutMs = 20000) {
    const key = this.key || this.readKey();
    if (!key) throw Object.assign(new Error("no gateway key"), { status: "nokey" });
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.cfg.url}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 401) this.key = null; // Reread: it may have been replaced.
    if (!response.ok) throw Object.assign(new Error(`relay answered ${response.status}`), { status: response.status });
    return response.json();
  }
}

let connector = null;

async function setup(context) {
  if (!context?.event?.subscribe || !context?.session?.prompt) return async () => {};
  const cfg = config();
  if (!cfg) return async () => {};
  connector ??= new Connector(cfg);
  const mine = connector;
  try {
    mine.addLocation(context);
  } catch (error) {
    mine.warn("setup", error);
  }
  return async () => {
    try { mine.removeLocation(context); } catch { /* Shutting down. */ }
    if (mine.stopped && connector === mine) connector = null;
  };
}

// OpenCode 1 calls every exported function as a plugin, so this one returns
// no hooks: it has no counterpart to the v2 context there.
export const RemoteControlPlugin = async () => ({});

export default { id: "tellico-remote-control", server: RemoteControlPlugin, setup };
