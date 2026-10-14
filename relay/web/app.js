// Tellico remote: your OpenCode sessions, on your phone.
//
// One page, three views -- sign in, the session list, one session -- driven by
// the relay's state and its event stream. Everything a session says arrives
// as ops (reducer.js); this file only turns them into DOM.

import { applyHost, applyOp, createState, loadState, loadTranscript } from "./reducer.js";
import { renderMarkdown, stripRecallTag } from "./markdown.js";
import { advance, safeCut } from "./pace.js";

const API = "./api";
const state = createState();
const app = document.getElementById("app");

let events = null;
let route = { name: "boot" };
let listTimer = null;
const pendingCommands = new Map(); // commandID -> { sessionID, type }

// --- helpers -----------------------------------------------------------------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}/${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "X-Tellico": "1", ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) },
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* empty body */ }
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(message, tone = "info") {
  const host = document.getElementById("toasts") || document.body.appendChild(el("div", { id: "toasts" }));
  const node = el("div", { class: `toast toast-${tone}`, role: "status", text: message });
  host.append(node);
  setTimeout(() => node.classList.add("toast-out"), 3600);
  setTimeout(() => node.remove(), 4000);
}

function basename(dir) {
  if (!dir) return "";
  const parts = String(dir).split("/").filter(Boolean);
  return parts[parts.length - 1] || dir;
}

function ago(ms) {
  if (!ms) return "";
  const seconds = Math.max(0, (Date.now() - ms) / 1000);
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 7 * 86400) return new Date(ms).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const KIND_LABEL = { tui: "Terminal", vscode: "VS Code", server: "Server" };

function agentLabel(agent) {
  if (!agent) return "";
  const m = /^(build|orchestrate)-tellico-(\d)$/.exec(agent) || /^tellico-(worker)-(\d)$/.exec(agent);
  return m ? `${m[1]} · node ${m[2]}` : agent;
}

function statusOf(meta) {
  if (!meta.online) return meta.status === "running" ? "offline-running" : "offline";
  return meta.status || "idle";
}

const STATUS_LABEL = {
  running: "Working",
  idle: "Idle",
  error: "Error",
  interrupted: "Stopped",
  offline: "Offline",
  "offline-running": "Offline",
};

function statusPill(meta) {
  const status = statusOf(meta);
  return el("span", { class: `pill pill-${status}` }, el("span", { class: "dot" }), STATUS_LABEL[status] || status);
}

function hostOf(meta) {
  return state.hosts.get(meta.hostId);
}

// --- routing -----------------------------------------------------------------

function parseRoute() {
  const hash = location.hash.replace(/^#/, "");
  const m = /^\/s\/(ses_[A-Za-z0-9_-]+)$/.exec(hash);
  return m ? { name: "session", sid: m[1] } : { name: "list" };
}

window.addEventListener("hashchange", () => {
  if (!state.user) return;
  route = parseRoute();
  render();
});

function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

// --- boot, sign-in, events --------------------------------------------------

async function boot() {
  try {
    const me = await api("me");
    state.user = me.user;
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }
    showFatal(error.message);
    return;
  }
  await reloadState();
  connect();
  route = parseRoute();
  render();
}

async function reloadState() {
  const payload = await api("state");
  loadState(state, payload);
  if (route.name === "session" && state.sessions.has(route.sid)) {
    await openTranscript(route.sid, true);
  }
}

function connect() {
  events?.close();
  events = new EventSource(`${API}/events`);
  let opened = false;
  events.addEventListener("hello", async event => {
    const { epoch } = JSON.parse(event.data);
    // A reconnect, or a relay that restarted: whatever streamed in between is
    // not in this copy, so start again from the relay's.
    if (opened || epoch !== state.epoch) {
      try { await reloadState(); render(); } catch { /* next hello retries */ }
    }
    opened = true;
    setConnection(true);
  });
  events.addEventListener("op", event => onOp(JSON.parse(event.data)));
  events.addEventListener("host", event => {
    applyHost(state, JSON.parse(event.data));
    scheduleList();
    if (route.name === "session") renderSessionChrome();
  });
  events.addEventListener("command", event => onCommand(JSON.parse(event.data)));
  events.addEventListener("reset", () => {
    events.close();
    setTimeout(connect, 500);
  });
  events.onerror = async () => {
    setConnection(false);
    if (events.readyState === EventSource.CLOSED) {
      // Closed for good: usually a sign-out elsewhere or an expired sign-in.
      try { await api("me"); setTimeout(connect, 3000); }
      catch (error) { if (error.status === 401) showLogin(); else setTimeout(connect, 5000); }
    }
  };
}

function setConnection(up) {
  document.body.classList.toggle("disconnected", !up);
}

function onOp(op) {
  const sid = applyOp(state, op);
  if (!sid) return;
  if (route.name === "session" && (sid === route.sid || state.sessions.get(sid)?.parentID === route.sid)) {
    updateSession(op);
  }
  scheduleList();
}

function onCommand(result) {
  const pending = pendingCommands.get(result.id);
  pendingCommands.delete(result.id);
  if (!result.ok) toast(result.error || "The machine could not run that.", "error");
  else if (pending?.type === "interrupt") toast("Stopped.");
  if (route.name === "session" && result.sessionID === route.sid) renderSessionChrome();
}

function showLogin(message) {
  events?.close();
  events = null;
  state.user = null;
  const input = el("input", {
    type: "password", id: "key", name: "key", placeholder: "sk-tellico-…",
    autocomplete: "off", autocapitalize: "off", spellcheck: "false", required: true,
  });
  const error = el("p", { class: "login-error", role: "alert", text: message || "" });
  const button = el("button", { class: "button button-primary", type: "submit", text: "Sign in" });
  const form = el("form", {
    class: "login-card",
    onsubmit: async event => {
      event.preventDefault();
      button.disabled = true;
      error.textContent = "";
      try {
        const me = await api("login", { method: "POST", body: JSON.stringify({ key: input.value.trim() }) });
        input.value = "";
        state.user = me.user;
        await reloadState();
        connect();
        route = parseRoute();
        render();
      } catch (failure) {
        error.textContent = failure.message;
        button.disabled = false;
      }
    },
  },
  el("img", { class: "login-logo", src: "icon.svg", alt: "" }),
  el("h1", { text: "Tellico" }),
  el("p", { class: "muted", text: "Follow and steer your OpenCode sessions from anywhere." }),
  el("label", { for: "key", class: "field-label", text: "Your Tellico API key" }),
  input,
  error,
  button,
  el("p", { class: "fine", text: "The key is checked once and not kept on this device; you stay signed in for 30 days." }));
  app.replaceChildren(el("main", { class: "login" }, el("div", { class: "glow", "aria-hidden": "true" }), form));
  input.focus();
}

function showFatal(message) {
  app.replaceChildren(el("main", { class: "login" }, el("div", { class: "login-card" },
    el("h1", { text: "Tellico" }),
    el("p", { class: "login-error", text: message }),
    el("button", { class: "button", text: "Try again", onclick: () => boot() }))));
}

async function signOut() {
  try { await api("logout", { method: "POST", body: "{}" }); } catch { /* signed out regardless */ }
  location.hash = "";
  showLogin();
}

// --- views -------------------------------------------------------------------

function render() {
  if (!state.user) return;
  if (route.name === "session") renderSession(route.sid);
  else renderList();
}

function scheduleList() {
  if (route.name !== "list" || listTimer) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    if (route.name === "list") renderList();
  }, 250);
}

function topLevel(meta) {
  return !meta.parentID || !state.sessions.has(meta.parentID);
}

// The last words of a reply as prose: a preview has no room for fences,
// heading marks or emphasis markers, which would otherwise show literally.
function plainPreview(text) {
  return stripRecallTag(text)
    .replace(/```[\w+.-]*/g, " ")
    .replace(/[`*_#>|]+/g, "")
    .replace(/^\s*([-+]|\d+[.)])\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sessionCard(meta) {
  const host = hostOf(meta);
  const workers = [...state.sessions.values()].filter(s => s.parentID === meta.id);
  const busyWorkers = workers.filter(s => s.status === "running" && s.online).length;
  const where = [basename(meta.directory), KIND_LABEL[host?.kind]].filter(Boolean).join(" · ");
  return el("button", { class: `card status-${statusOf(meta)}`, onclick: () => go(`#/s/${meta.id}`) },
    el("div", { class: "card-top" },
      el("span", { class: "card-title", text: meta.title || "New session" }),
      el("span", { class: "card-time", text: ago(meta.updated) })),
    el("div", { class: "card-meta" },
      statusPill(meta),
      meta.agent ? el("span", { class: "chip", text: agentLabel(meta.agent) }) : null,
      el("span", { class: "card-where", text: where }),
      workers.length ? el("span", { class: "card-workers", text: busyWorkers ? `${busyWorkers}/${workers.length} workers busy` : `${workers.length} worker${workers.length > 1 ? "s" : ""}` }) : null),
    meta.preview ? el("p", { class: "card-preview", text: plainPreview(meta.preview) }) : null);
}

function renderList() {
  const sessions = [...state.sessions.values()].filter(topLevel)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0));
  const running = sessions.filter(s => s.status === "running" && s.online);
  const rest = sessions.filter(s => !(s.status === "running" && s.online));

  // Group the rest by machine, online machines first.
  const machines = new Map();
  for (const meta of rest) {
    const host = hostOf(meta);
    const machine = host?.machine || "Unknown machine";
    if (!machines.has(machine)) machines.set(machine, { online: false, sessions: [] });
    const group = machines.get(machine);
    group.sessions.push(meta);
    if (host?.online) group.online = true;
  }
  for (const host of state.hosts.values()) {
    if (host.online && !machines.has(host.machine)) machines.set(host.machine, { online: true, sessions: [] });
  }
  const groups = [...machines.entries()].sort((a, b) => Number(b[1].online) - Number(a[1].online));

  const header = el("header", { class: "bar" },
    el("div", { class: "bar-title" }, el("img", { class: "bar-logo", src: "icon.svg", alt: "" }), el("span", { text: "Tellico" })),
    el("div", { class: "bar-right" },
      el("span", { class: "bar-user", text: state.user }),
      el("button", { class: "text-button", onclick: signOut, text: "Sign out" })));

  const body = [];
  if (!sessions.length && ![...state.hosts.values()].some(h => h.online)) {
    body.push(el("section", { class: "empty" },
      el("h2", { text: "No machines connected yet" }),
      el("p", { text: "Turn on remote control on each computer you run Tellico on, then start a new session there:" }),
      el("pre", { class: "md-pre", text: "./install.sh --no-start --remote-control" }),
      el("p", { class: "muted", text: "Windows and terminals that were already open keep running as they were; they appear here once restarted." })));
  }
  if (running.length) {
    body.push(el("section", { class: "group" },
      el("h2", { class: "group-title" }, el("span", { class: "dot dot-live" }), "Working now"),
      ...running.map(sessionCard)));
  }
  for (const [machine, group] of groups) {
    body.push(el("section", { class: `group${group.online ? "" : " group-offline"}` },
      el("h2", { class: "group-title" },
        el("span", { class: `dot ${group.online ? "dot-online" : "dot-offline"}` }),
        machine,
        el("span", { class: "group-note", text: group.online ? "" : "offline" })),
      group.sessions.length ? group.sessions.map(sessionCard) : el("p", { class: "muted small", text: "Connected. Sessions appear here as soon as they do something." })));
  }

  const machinesOnline = new Set([...state.hosts.values()].filter(h => h.online).map(h => h.machine)).size;
  const summary = [
    running.length ? `${running.length} working` : "Nothing running",
    `${machinesOnline} machine${machinesOnline === 1 ? "" : "s"} online`,
  ].join(" · ");
  const hero = el("div", { class: "hero" }, el("h1", { text: "Sessions" }), el("p", { class: "hero-sub", text: summary }));
  app.replaceChildren(el("div", { class: "view view-list" }, header, el("main", { class: "list" }, hero, body)));
}

// --- one session ---------------------------------------------------------------

let view = null; // the open session's DOM and pacing state

async function openTranscript(sid, force) {
  if (!force && state.transcripts.has(sid)) return state.transcripts.get(sid);
  const payload = await api(`session/${sid}`);
  return loadTranscript(state, sid, payload);
}

async function renderSession(sid) {
  if (view?.frame) cancelAnimationFrame(view.frame);
  view = null;
  const meta = state.sessions.get(sid);
  if (!meta) {
    app.replaceChildren(el("div", { class: "view" },
      el("header", { class: "bar" }, el("button", { class: "icon-button", onclick: () => go("#/"), "aria-label": "Back", text: "‹" }), el("div", { class: "bar-title", text: "Session" })),
      el("main", { class: "empty" }, el("p", { text: "That session is not here any more." }))));
    return;
  }

  const transcriptNode = el("div", { class: "transcript", role: "log", "aria-live": "polite" });
  const scroller = el("main", { class: "scroller" }, transcriptNode);
  const chrome = el("div", { class: "session-chrome" });
  const workers = el("nav", { class: "workers" });
  const composer = el("div", { class: "composer-slot" });
  app.replaceChildren(el("div", { class: "view view-session" }, chrome, workers, scroller, composer));

  view = {
    sid, scroller, transcriptNode, chrome, workers, composer,
    messages: new Map(), // messageID -> { node, parts: Map(key -> part view) }
    pacing: new Set(),
    frame: 0,
    pinned: true,
    composerSignature: null,
  };
  scroller.addEventListener("scroll", () => {
    view.pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  }, { passive: true });

  renderSessionChrome();
  transcriptNode.append(el("p", { class: "muted small center", text: "Loading…" }));
  try {
    await openTranscript(sid, true);
  } catch (error) {
    transcriptNode.replaceChildren(el("p", { class: "login-error", text: error.message }));
    return;
  }
  if (!view || view.sid !== sid) return;
  transcriptNode.replaceChildren();
  const transcript = state.transcripts.get(sid);
  for (const message of transcript.messages.values()) renderMessage(message, false);
  scrollToEnd(true);
}

function renderSessionChrome() {
  if (!view) return;
  const meta = state.sessions.get(view.sid);
  if (!meta) return;
  const host = hostOf(meta);
  const parent = meta.parentID && state.sessions.get(meta.parentID);
  const sub = [host?.machine, KIND_LABEL[host?.kind], basename(meta.directory), agentLabel(meta.agent)].filter(Boolean).join(" · ");
  view.chrome.replaceChildren(el("header", { class: "bar bar-session" },
    el("button", { class: "icon-button", "aria-label": "Back", onclick: () => go(parent ? `#/s/${parent.id}` : "#/"), text: "‹" }),
    el("div", { class: "bar-stack" },
      el("div", { class: "bar-title-text", text: meta.title || "New session" }),
      el("div", { class: "bar-sub", text: sub })),
    statusPill(meta)));

  const children = [...state.sessions.values()].filter(s => s.parentID === view.sid);
  view.workers.replaceChildren(...children.map(child => el("button", {
    class: `worker status-${statusOf(child)}`,
    onclick: () => go(`#/s/${child.id}`),
  }, el("span", { class: "dot" }), agentLabel(child.agent) || child.title || "worker")));
  view.workers.hidden = !children.length;

  renderComposer(meta, host);
}

function renderComposer(meta, host) {
  const running = meta.status === "running";
  const online = !!host?.online;
  const isWorker = !!meta.parentID;
  // Rebuilding the textarea would close the phone's keyboard mid-sentence, so
  // only rebuild when something it shows has actually changed.
  const signature = `${running}|${online}|${isWorker}|${host?.machine}`;
  if (view.composerSignature === signature) return;
  view.composerSignature = signature;
  const reason = !online ? `${host?.machine || "That machine"} is offline.`
    : isWorker ? "Workers take their instructions from their lead." : null;

  const input = el("textarea", {
    class: "composer-input", rows: 1, placeholder: running ? "Steer it…" : "Message",
    disabled: !!reason, "aria-label": "Message",
    oninput: () => {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
    },
    onkeydown: event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send();
    },
  });
  const sendButton = el("button", { class: "round round-send", "aria-label": "Send", title: "Send", disabled: !!reason, onclick: () => send(), text: "↑" });
  const stopButton = running && online && !isWorker
    ? el("button", { class: "round round-stop", "aria-label": "Stop", title: "Stop", onclick: () => stop() }, el("span", { class: "stop-square" }))
    : null;

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendButton.disabled = true;
    try {
      const { commandID } = await api(`session/${meta.id}/prompt`, { method: "POST", body: JSON.stringify({ text }) });
      pendingCommands.set(commandID, { sessionID: meta.id, type: "prompt" });
      input.value = "";
      input.style.height = "auto";
      view.pinned = true;
    } catch (error) {
      toast(error.message, "error");
    } finally {
      sendButton.disabled = false;
    }
  }

  async function stop() {
    try {
      const { commandID } = await api(`session/${meta.id}/interrupt`, { method: "POST", body: "{}" });
      pendingCommands.set(commandID, { sessionID: meta.id, type: "interrupt" });
    } catch (error) {
      toast(error.message, "error");
    }
  }

  // Keep a half-written message, and the keyboard, across the rebuild.
  const previous = view.composer.querySelector("textarea");
  const hadFocus = previous && document.activeElement === previous;
  if (previous && !reason) input.value = previous.value;

  view.composer.replaceChildren(el("footer", { class: "composer" },
    reason ? el("p", { class: "composer-reason", text: reason }) : null,
    el("div", { class: "composer-row" }, input, stopButton, sendButton)));
  if (hadFocus && !reason) input.focus();
}

function messageView(message) {
  let entry = view.messages.get(message.id);
  if (entry) return entry;
  const node = el("article", { class: `msg msg-${message.role}` });
  entry = { node, parts: new Map(), body: null };
  if (message.role === "assistant") {
    entry.body = el("div", { class: "msg-body" });
    node.append(entry.body);
  }
  view.messages.set(message.id, entry);
  // Messages arrive in order; a late one (a snapshot refill) is placed by id,
  // which OpenCode issues in time order.
  const after = [...view.messages.keys()].filter(id => id !== message.id && id > message.id).sort()[0];
  const before = after && view.messages.get(after)?.node;
  if (before && before.parentNode === view.transcriptNode) view.transcriptNode.insertBefore(node, before);
  else view.transcriptNode.append(node);
  return entry;
}

function renderMessage(message, live) {
  const entry = messageView(message);
  if (message.role === "user") {
    entry.node.replaceChildren(el("div", { class: "bubble", text: message.text || "" }));
  } else if (message.role === "note") {
    entry.node.replaceChildren(el("p", { class: "note", text: message.text || "" }));
  } else {
    for (const part of message.parts.values()) renderPart(entry, part, live);
    entry.node.querySelector(".msg-error")?.remove();
    if (message.error) entry.node.append(el("p", { class: "msg-error", text: message.error }));
  }
}

function renderPart(entry, part, live) {
  let pv = entry.parts.get(part.key);
  if (!pv) {
    pv = { part, node: null, shown: 0, rendered: -1 };
    if (part.kind === "text") {
      pv.node = el("div", { class: "md" });
    } else if (part.kind === "reasoning") {
      pv.body = el("div", { class: "reasoning-body" });
      pv.label = el("summary", { class: "reasoning-label" });
      pv.node = el("details", { class: "reasoning" }, pv.label, pv.body);
    } else {
      pv.node = el("details", { class: "tool" });
    }
    entry.parts.set(part.key, pv);
    entry.body.append(pv.node);
  }
  pv.part = part;

  if (part.kind === "text") {
    if (!live) pv.shown = (part.text || "").length;
    paceOrPaint(pv);
  } else if (part.kind === "reasoning") {
    pv.label.textContent = part.done ? "✦ Thought" : "✦ Thinking…";
    pv.node.classList.toggle("reasoning-live", !part.done);
    pv.body.textContent = part.text || "";
  } else {
    renderTool(pv, part);
  }
}

function renderTool(pv, part) {
  const status = part.status || "running";
  const icon = status === "done" ? "✓" : status === "error" ? "✕" : "";
  const question = part.tool === "question";
  const summary = el("summary", { class: `tool-row tool-${status}` },
    el("span", { class: "tool-icon", text: icon }),
    el("span", { class: "tool-name", text: question ? "Question" : (part.tool || "tool") }),
    el("span", { class: "tool-summary", text: part.summary || "" }));
  const body = [];
  if (question && status === "running") body.push(el("p", { class: "tool-ask", text: "It is waiting for an answer. Answer it on the computer." }));
  if (part.input) body.push(el("pre", { class: "md-pre tool-pre", text: part.input }));
  if (part.output) body.push(el("pre", { class: "md-pre tool-pre", text: part.output }));
  if (part.error) body.push(el("p", { class: "msg-error", text: part.error }));
  const open = pv.node.open || (question && status === "running");
  pv.node.replaceChildren(summary, ...body);
  pv.node.open = open;
}

// Text that arrived while this view was open is revealed at a steady pace;
// text that was already there when it opened is painted at once.
function paceOrPaint(pv) {
  const target = (pv.part.text || "").length;
  if (pv.shown >= target) {
    pv.shown = target;
    paint(pv);
    return;
  }
  const owner = view;
  owner.pacing.add(pv);
  if (!owner.frame) {
    let last = performance.now();
    const tick = now => {
      // A frame scheduled for a view that has since been replaced stops here.
      if (view !== owner) return;
      const dt = Math.min(64, now - last);
      last = now;
      for (const item of owner.pacing) {
        const text = item.part.text || "";
        item.shown = advance(item.shown, text.length, dt, !!item.part.done);
        paint(item);
        if (item.shown >= text.length) owner.pacing.delete(item);
      }
      scrollToEnd(false);
      owner.frame = owner.pacing.size ? requestAnimationFrame(tick) : 0;
    };
    owner.frame = requestAnimationFrame(tick);
  }
}

function paint(pv) {
  const text = pv.part.text || "";
  const n = safeCut(text, Math.floor(pv.shown));
  if (n === pv.rendered) return;
  pv.rendered = n;
  pv.node.replaceChildren(renderMarkdown(stripRecallTag(text.slice(0, n))));
  pv.node.classList.toggle("md-live", n < text.length || !pv.part.done);
}

function scrollToEnd(force) {
  if (!view) return;
  if (force || view.pinned) view.scroller.scrollTop = view.scroller.scrollHeight;
}

function updateSession(op) {
  if (!view) return;
  if (op.sessionID !== view.sid) {
    renderSessionChrome(); // a worker changed
    return;
  }
  const transcript = state.transcripts.get(view.sid);
  if (!transcript) return;
  if (op.op === "snapshot") {
    view.transcriptNode.replaceChildren();
    view.messages.clear();
    view.pacing.clear();
    for (const message of transcript.messages.values()) renderMessage(message, false);
    scrollToEnd(true);
  } else if (op.op === "message" || op.op === "part" || op.op === "append") {
    const id = op.op === "message" ? op.message.id : op.messageID;
    const message = transcript.messages.get(id);
    if (message) renderMessage(message, true);
    scrollToEnd(false);
  }
  if (op.op === "session" || op.op === "status" || op.op === "snapshot") renderSessionChrome();
}

window.addEventListener("hashchange", () => {
  if (route.name !== "session" && view) {
    if (view.frame) cancelAnimationFrame(view.frame);
    view = null;
  }
});

// Relative times age while the list is open.
setInterval(() => { if (route.name === "list" && state.user) scheduleList(); }, 30000);

boot();
