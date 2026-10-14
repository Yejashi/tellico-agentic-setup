// The phone's copy of the relay's state, kept current by the same ops the
// relay applies (see plugins/remote-control/protocol.js for the vocabulary).
// Pure: no DOM, so tests/relay.test.mjs runs it against the same fixture the
// relay's own tests use, and the two cannot drift apart.

export const MAX_MESSAGES = 400;

export function createState() {
  return { user: null, epoch: null, hosts: new Map(), sessions: new Map(), transcripts: new Map() };
}

export function loadState(state, payload) {
  state.user = payload.user;
  state.epoch = payload.epoch;
  state.hosts = new Map((payload.hosts || []).map(h => [h.id, h]));
  state.sessions = new Map((payload.sessions || []).map(s => [s.id, s]));
  // Transcripts are fetched per session on demand and refreshed then.
  for (const sid of [...state.transcripts.keys()]) {
    if (!state.sessions.has(sid)) state.transcripts.delete(sid);
  }
  return state;
}

export function loadTranscript(state, sid, payload) {
  const transcript = { messages: new Map() };
  for (const raw of payload.messages || []) addMessage(transcript, raw);
  state.transcripts.set(sid, transcript);
  if (payload.session) state.sessions.set(sid, { ...state.sessions.get(sid), ...payload.session });
  return transcript;
}

function addMessage(transcript, raw) {
  const { parts = [], ...header } = raw;
  const message = { ...header, parts: new Map() };
  for (const part of parts) message.parts.set(part.key, { ...part });
  transcript.messages.set(raw.id, message);
  return message;
}

function ensureMessage(transcript, id, role = "assistant") {
  let message = transcript.messages.get(id);
  if (!message) {
    message = { id, role, parts: new Map() };
    transcript.messages.set(id, message);
    while (transcript.messages.size > MAX_MESSAGES) {
      transcript.messages.delete(transcript.messages.keys().next().value);
    }
  }
  return message;
}

function touchSession(state, op) {
  let meta = state.sessions.get(op.sessionID);
  if (!meta) {
    meta = { id: op.sessionID, status: "idle", hostId: op.hostId };
    state.sessions.set(op.sessionID, meta);
  }
  if (op.hostId) {
    meta.hostId = op.hostId;
    const host = state.hosts.get(op.hostId);
    if (host) meta.online = host.online;
  }
  return meta;
}

function previewFrom(message) {
  if (!message) return undefined;
  if (message.role === "user" && message.text) return message.text.slice(0, 160);
  const parts = [...message.parts.values()].reverse();
  const text = parts.find(p => p.kind === "text" && p.text);
  return text ? text.text.slice(-160) : undefined;
}

// Returns which session changed, so the view can redraw only what it shows.
export function applyOp(state, op) {
  if (!op || typeof op.sessionID !== "string") return null;
  const sid = op.sessionID;

  if (op.op === "remove") {
    state.sessions.delete(sid);
    state.transcripts.delete(sid);
    return sid;
  }

  const meta = touchSession(state, op);
  const transcript = state.transcripts.get(sid);

  switch (op.op) {
    case "session":
      Object.assign(meta, op.session || {});
      break;
    case "status":
      meta.status = op.status;
      if (op.detail) meta.detail = op.detail;
      else delete meta.detail;
      break;
    case "snapshot": {
      Object.assign(meta, op.session || {});
      const fresh = { messages: new Map() };
      for (const raw of op.messages || []) addMessage(fresh, raw);
      if (transcript) state.transcripts.set(sid, fresh);
      meta.messageCount = fresh.messages.size;
      const last = [...fresh.messages.values()].pop();
      const preview = previewFrom(last);
      if (preview) meta.preview = preview;
      break;
    }
    case "message": {
      if (transcript) {
        const message = ensureMessage(transcript, op.message.id, op.message.role);
        Object.assign(message, op.message);
        meta.messageCount = transcript.messages.size;
      }
      if (op.message.role === "user" && op.message.text) meta.preview = op.message.text.slice(0, 160);
      break;
    }
    case "part": {
      if (transcript) {
        const message = ensureMessage(transcript, op.messageID);
        const part = message.parts.get(op.part.key) || { key: op.part.key, kind: op.part.kind };
        Object.assign(part, op.part);
        message.parts.set(op.part.key, part);
      }
      if (op.part.kind === "text" && op.part.text) meta.preview = op.part.text.slice(-160);
      break;
    }
    case "append": {
      if (transcript) {
        const message = ensureMessage(transcript, op.messageID);
        const part = message.parts.get(op.key) || { key: op.key, kind: op.kind, text: "", done: false };
        part.text = (part.text || "") + op.text;
        message.parts.set(op.key, part);
        if (op.kind === "text") meta.preview = part.text.slice(-160);
      } else if (op.kind === "text") {
        meta.preview = ((meta.preview || "") + op.text).slice(-160);
      }
      break;
    }
    default:
      return null;
  }
  return sid;
}

export function applyHost(state, host) {
  state.hosts.set(host.id, host);
  for (const meta of state.sessions.values()) {
    if (meta.hostId === host.id) meta.online = host.online;
  }
}

// The transcript as plain arrays, in the shape the relay exports, for tests.
export function exportTranscript(state, sid) {
  const transcript = state.transcripts.get(sid);
  if (!transcript) return null;
  return [...transcript.messages.values()].map(({ parts, ...header }) => ({ ...header, parts: [...parts.values()] }));
}
