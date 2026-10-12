// Dispatch guidance and optional metadata-only timing for OpenCode 1 and 2.
// A background tool returns an acknowledgement, not worker completion. Never
// infer node occupancy from it or encourage tasks just to occupy both servers.
import { constants, openSync, closeSync, fstatSync, writeSync } from "node:fs";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";

const DISPATCH_TOOLS = new Set(["task", "subagent"]);
const WORKER_NODE_RE = /^tellico-worker-([01])$/;
const MAX_TRACKED = 4096;

function createTracker() {
  const calls = new Map();
  const pending = new Map();
  const warned = new Set();
  const value = process.env.OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS;
  const background = value === "true" || value === "1";
  const tracePath = process.env.TELLICO_AGENT_TRACE;
  const tracing = tracePath && isAbsolute(tracePath);
  const lead = process.env.TELLICO_LEAD_NODE;
  const modeLine = background
    ? "Dispatch mode: background is enabled. Use background: true only if the tool supports it; a dispatch return is an acknowledgement, not worker completion. Collect completion reports for every required task. Idle workers are acceptable."
    : "Dispatch mode: foreground. Omit background (or set false if supported); collect all worker reports before finishing. Idle workers are acceptable.";

  function trace(record) {
    if (!tracing) return;
    let fd;
    try {
      // Never follow a symlink or block on a pipe/device. Files created here
      // are private; existing files keep the permissions the user chose.
      fd = openSync(tracePath, constants.O_WRONLY | constants.O_APPEND |
        constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      if (!fstatSync(fd).isFile()) return;
      writeSync(fd, JSON.stringify({ at: new Date().toISOString(),
        pid: process.pid, ...record }) + "\n");
    } catch {
      // Diagnostics must never block a tool or fail a session.
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort. */ } }
    }
  }

  function before(sessionID, callID, tool, args) {
    try {
      if (!sessionID || !callID) return;
      const dispatch = DISPATCH_TOOLS.has(tool);
      if (!dispatch && !tracing) return;
      const agentValue = args && (args.subagent_type || args.agent || args.agentName);
      const agent = dispatch && typeof agentValue === "string" ? agentValue : "";
      const node = WORKER_NODE_RE.exec(agent)?.[1] || null;
      // Classify the actual call. Unknown mode is excluded from occupancy
      // accounting: launch-time enablement does not prove a call's mode.
      const taskMode = !dispatch ? null
        : args?.background === true ? "background"
        : args?.background === false || !background ? "foreground" : "unknown";
      if (dispatch && taskMode === "foreground" && node && !warned.has(sessionID)) {
        const duplicate = [...calls.values()].some(entry =>
          entry.sessionID === sessionID && entry.agent === agent &&
          entry.taskMode === "foreground");
        if (duplicate) {
          if (warned.size >= MAX_TRACKED) warned.delete(warned.values().next().value);
          warned.add(sessionID);
          if (pending.size >= MAX_TRACKED) pending.delete(pending.keys().next().value);
          pending.set(sessionID,
            `Dispatch: concurrent foreground calls target ${agent}. If independent, use separate workers; if dependent, run sequentially. Do not create extra work to fill a server.`);
        }
      }
      const key = JSON.stringify([sessionID, callID]);
      if (calls.size >= MAX_TRACKED) calls.delete(calls.keys().next().value);
      // Store no arguments, prompt text, commands, paths or tool outputs.
      calls.set(key, { sessionID, callID, tool, dispatch, agent, node,
        taskMode, start: performance.now() });
      trace({ event: dispatch ? "dispatch_start" : "tool_start",
        session: sessionID, call: callID, tool,
        lead_node: lead === "0" || lead === "1" ? lead : null,
        ...(dispatch ? { worker: node ? agent : null, node, mode: taskMode,
          resumed: typeof args?.task_id === "string" && args.task_id.length > 0 } : {}) });
    } catch {
      // Optional guidance must never fail the user's work.
    }
  }

  function after(sessionID, callID, tool) {
    try {
      const key = JSON.stringify([sessionID, callID]);
      const entry = calls.get(key);
      if (!entry || entry.tool !== tool) return;
      calls.delete(key);
      trace({ event: entry.dispatch ? "dispatch_return" : "tool_return",
        session: sessionID, call: callID, tool,
        duration_ms: Math.round(performance.now() - entry.start),
        ...(entry.dispatch ? { worker: entry.node ? entry.agent : null,
          node: entry.node, mode: entry.taskMode,
          // Tool return does not prove success, even for a foreground task.
          completion_observable: entry.taskMode === "foreground" } : {}) });
    } catch { /* As above. */ }
  }

  function context(sessionID) {
    const lines = [modeLine];
    const nudge = pending.get(sessionID);
    if (nudge) { pending.delete(sessionID); lines.push(nudge); }
    return lines;
  }
  return { before, after, context };
}

export const DispatchBalancePlugin = async () => {
  const tracker = createTracker();
  return {
    "tool.execute.before": async (input, output) => {
      if (input) tracker.before(input.sessionID, input.callID, input.tool, output?.args);
    },
    "tool.execute.after": async input => {
      if (input) tracker.after(input.sessionID, input.callID, input.tool);
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!input || !Array.isArray(output?.system)) return;
      output.system.push(...tracker.context(input.sessionID));
    },
  };
};

async function setup(context) {
  const tracker = createTracker();
  const registrations = [
    await context.tool.hook("execute.before", event => {
      if (event) tracker.before(event.sessionID, event.id, event.tool, event.input);
    }),
    await context.tool.hook("execute.after", event => {
      if (event) tracker.after(event.sessionID, event.id, event.tool);
    }),
    await context.session.hook("context", request => {
      if (!Array.isArray(request?.system)) return;
      for (const text of tracker.context(request.sessionID)) {
        request.system.push({ type: "text", text });
      }
    }),
  ];
  return async () => {
    for (const registration of registrations) {
      try { await registration.dispose(); } catch { /* Shutting down. */ }
    }
  };
}

export default { id: "tellico-dispatch-balance", server: DispatchBalancePlugin, setup };
