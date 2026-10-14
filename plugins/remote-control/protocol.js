// OpenCode 2 events and session history, translated into the relay's ops.
//
// Pure functions, no I/O, so they are tested against events recorded from a
// real 2.0.26 server (tests/fixtures/opencode2-events.jsonl). Everything that
// knows OpenCode's event names lives here: after an OpenCode upgrade, this is
// the file to recheck.
//
// The ops are deliberately small and idempotent, so the relay and the phone
// apply the same vocabulary and a replay converges on the same state:
//
//   session   upsert session metadata (title, directory, agent, status ...)
//   snapshot  replace a session's whole transcript (from session.context)
//   message   upsert one message header (a user prompt, an assistant step)
//   part      upsert one part of a message (text, reasoning, tool call)
//   append    add streamed text to a text or reasoning part
//   status    the session started, finished, failed or was interrupted
//
// Parts are keyed so that live events and history agree: text and reasoning by
// kind and per-kind ordinal ("text:0", "reasoning:0"), tool calls by their call
// id ("tool:call_..."). Assistant messages are one per step, keyed by the id
// OpenCode gives the step; user messages by their inbox id, which is the same
// id the history later shows.

export const LIMITS = {
  // What a phone needs to recognise a tool call, not its whole payload.
  toolInput: 2000,
  toolOutput: 4000,
  summary: 200,
  userText: 64000,
  // Messages kept per session in a snapshot; older ones are dropped.
  messages: 400,
};

function clip(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function stringify(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return ""; }
}

// One line that identifies a tool call at a glance: the command it ran, the
// file it touched, the pattern it searched for.
export function summarizeTool(name, input) {
  if (input == null) return "";
  if (typeof input === "string") return clip(input.split("\n")[0], LIMITS.summary);
  if (name === "question" && Array.isArray(input.questions) && input.questions[0]) {
    return clip(input.questions[0].question ?? input.questions[0].text ?? "", LIMITS.summary);
  }
  const pick = input.command ?? input.description ?? input.filePath ?? input.file_path ??
    input.path ?? input.pattern ?? input.url ?? input.query ?? input.prompt ?? input.agent;
  if (typeof pick === "string") return clip(pick.split("\n")[0], LIMITS.summary);
  return clip(stringify(input), LIMITS.summary);
}

function toolOutput(content) {
  if (typeof content === "string") return clip(content, LIMITS.toolOutput);
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(item => item && item.type === "text" && typeof item.text === "string")
    .map(item => item.text)
    .join("\n");
  return clip(text, LIMITS.toolOutput);
}

function errorMessage(error) {
  if (!error) return undefined;
  if (typeof error === "string") return clip(error, LIMITS.summary * 4);
  return clip(error.message ?? error.type ?? stringify(error), LIMITS.summary * 4);
}

const TOOL_STATUS = {
  pending: "running",
  running: "running",
  completed: "done",
  success: "done",
  error: "error",
  failed: "error",
};

function modelName(model) {
  if (!model || typeof model !== "object") return undefined;
  return model.id ? (model.providerID ? `${model.providerID}/${model.id}` : model.id) : undefined;
}

// A live event, as context.event.subscribe yields it, as zero or more ops.
// Returns null for events that concern no session.
export function translateEvent(ev) {
  if (!ev || typeof ev.type !== "string") return null;
  const data = ev.data || {};
  const sessionID = data.sessionID;
  if (typeof sessionID !== "string") return null;
  const at = typeof ev.created === "number" ? ev.created : Date.now();
  const directory = ev.location?.directory;
  const ops = [];
  const session = fields => ops.push({ op: "session", sessionID, session: { updated: at, ...fields } });
  const messageID = data.assistantMessageID;

  switch (ev.type) {
    case "session.created":
      session({
        parentID: data.parentID ?? null,
        directory: data.location?.directory ?? directory,
        model: modelName(data.model),
        created: at,
        status: "idle",
      });
      break;
    case "session.renamed":
      session({ title: clip(data.title, LIMITS.summary) });
      break;
    case "session.inbox.enqueued": {
      const item = data.item || {};
      const text = item.payload?.text;
      if (typeof text !== "string") break;
      ops.push({
        op: "message",
        sessionID,
        message: {
          id: data.inboxID,
          role: item.type === "user" ? "user" : "note",
          time: at,
          text: clip(text, LIMITS.userText),
        },
      });
      session({});
      break;
    }
    case "session.execution.started":
      ops.push({ op: "status", sessionID, status: "running" });
      session({});
      break;
    case "session.execution.succeeded":
      ops.push({ op: "status", sessionID, status: "idle" });
      session({});
      break;
    case "session.execution.interrupted":
      ops.push({ op: "status", sessionID, status: "interrupted" });
      session({});
      break;
    case "session.execution.failed":
    case "session.error":
      ops.push({ op: "status", sessionID, status: "error", detail: errorMessage(data.error) });
      session({});
      break;
    case "session.step.started":
      if (!messageID) break;
      ops.push({
        op: "message",
        sessionID,
        message: { id: messageID, role: "assistant", time: data.started ?? at, agent: data.agent, model: modelName(data.model) },
      });
      session({ agent: data.agent, model: modelName(data.model) });
      break;
    case "session.step.ended":
      if (!messageID) break;
      ops.push({ op: "message", sessionID, message: { id: messageID, role: "assistant", finish: data.finish } });
      break;
    case "session.step.failed":
      if (!messageID) break;
      ops.push({ op: "message", sessionID, message: { id: messageID, role: "assistant", error: errorMessage(data.error) } });
      break;
    case "session.usage.updated":
      session({ tokens: data.tokens, cost: data.cost });
      break;
    case "session.text.started":
    case "session.reasoning.started": {
      if (!messageID) break;
      const kind = ev.type === "session.text.started" ? "text" : "reasoning";
      ops.push({ op: "part", sessionID, messageID, part: { key: `${kind}:${data.ordinal ?? 0}`, kind, text: "", done: false } });
      break;
    }
    case "session.text.delta":
    case "session.reasoning.delta": {
      if (!messageID || typeof data.delta !== "string") break;
      const kind = ev.type === "session.text.delta" ? "text" : "reasoning";
      ops.push({ op: "append", sessionID, messageID, key: `${kind}:${data.ordinal ?? 0}`, kind, text: data.delta });
      break;
    }
    case "session.text.ended":
    case "session.reasoning.ended": {
      if (!messageID) break;
      const kind = ev.type === "session.text.ended" ? "text" : "reasoning";
      // The full text, which also repairs anything a late join duplicated.
      const part = { key: `${kind}:${data.ordinal ?? 0}`, kind, done: true };
      if (typeof data.text === "string") part.text = data.text;
      ops.push({ op: "part", sessionID, messageID, part });
      break;
    }
    case "session.tool.input.started":
      if (!messageID || !data.id) break;
      ops.push({ op: "part", sessionID, messageID, part: { key: `tool:${data.id}`, kind: "tool", tool: data.name, status: "running" } });
      break;
    case "session.tool.called":
      if (!messageID || !data.id) break;
      ops.push({
        op: "part",
        sessionID,
        messageID,
        part: {
          key: `tool:${data.id}`,
          kind: "tool",
          status: "running",
          summary: summarizeTool(data.name, data.input),
          input: clip(stringify(data.input), LIMITS.toolInput),
        },
      });
      break;
    case "session.tool.success":
      if (!messageID || !data.id) break;
      ops.push({ op: "part", sessionID, messageID, part: { key: `tool:${data.id}`, kind: "tool", status: "done", output: toolOutput(data.content) } });
      break;
    case "session.tool.failed":
      if (!messageID || !data.id) break;
      ops.push({ op: "part", sessionID, messageID, part: { key: `tool:${data.id}`, kind: "tool", status: "error", error: errorMessage(data.error) } });
      break;
    default:
      // Anything else that names a session still proves it is alive here.
      if (ev.type.startsWith("session.")) session({});
      else return null;
  }
  return { sessionID, directory, ops };
}

function historyParts(content) {
  const parts = [];
  const ordinals = { text: 0, reasoning: 0 };
  for (const item of Array.isArray(content) ? content : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" || item.type === "reasoning") {
      const kind = item.type;
      parts.push({ key: `${kind}:${ordinals[kind]++}`, kind, text: String(item.text ?? ""), done: true });
    } else if (item.type === "tool" && item.id) {
      const state = item.state || {};
      const part = {
        key: `tool:${item.id}`,
        kind: "tool",
        tool: item.name,
        status: TOOL_STATUS[state.status] ?? "running",
        summary: summarizeTool(item.name, state.input),
        input: clip(stringify(state.input), LIMITS.toolInput),
      };
      const output = toolOutput(state.content ?? state.output);
      if (output) part.output = output;
      const error = errorMessage(state.error);
      if (error) part.error = error;
      parts.push(part);
    }
  }
  return parts;
}

// session.get and session.context, as one op that replaces the transcript.
// Used the first time a session is seen in this process and after the relay
// asks for a resync, so a resumed session arrives with its history.
export function snapshotFromHistory(info, history, status) {
  const sessionID = info?.id;
  if (typeof sessionID !== "string") return null;
  const messages = [];
  let agent;
  for (const m of Array.isArray(history) ? history : []) {
    if (!m || typeof m.id !== "string") continue;
    const time = m.time?.created;
    if (m.type === "user") {
      const text = m.text ?? m.payload?.text;
      if (typeof text === "string") messages.push({ id: m.id, role: "user", time, text: clip(text, LIMITS.userText) });
    } else if (m.type === "assistant") {
      if (m.agent) agent = m.agent;
      const message = { id: m.id, role: "assistant", time, agent: m.agent, model: modelName(m.model), parts: historyParts(m.content) };
      if (m.finish) message.finish = m.finish;
      const error = errorMessage(m.error);
      if (error) message.error = error;
      messages.push(message);
    } else if (m.type === "synthetic" && typeof (m.text ?? m.payload?.text) === "string") {
      messages.push({ id: m.id, role: "note", time, text: clip(m.text ?? m.payload.text, LIMITS.userText) });
    }
  }
  const session = {
    parentID: info.parentID ?? null,
    title: info.title ? clip(info.title, LIMITS.summary) : undefined,
    directory: info.location?.directory,
    agent,
    model: modelName(info.model),
    tokens: info.tokens,
    cost: info.cost,
    created: info.time?.created,
    updated: info.time?.updated ?? Date.now(),
  };
  if (status) session.status = status;
  return { op: "snapshot", sessionID, session, messages: messages.slice(-LIMITS.messages) };
}

// Streaming produces one append per token; consecutive appends to the same
// part are merged before they go on the wire.
export function coalesce(ops) {
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (op.op === "append" && last && last.op === "append" &&
      last.sessionID === op.sessionID && last.messageID === op.messageID && last.key === op.key) {
      out[out.length - 1] = { ...last, text: last.text + op.text };
    } else {
      out.push(op);
    }
  }
  return out;
}
