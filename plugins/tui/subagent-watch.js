// Vendored verbatim from opencode-subagent-watch 0.4.0, dist/tui.js
// https://github.com/darcien/opencode-subagent-watch
// https://registry.npmjs.org/opencode-subagent-watch/-/opencode-subagent-watch-0.4.0.tgz
//
// Only this header is ours. To upgrade, replace everything below it with the
// new release's dist/tui.js and bump the version above; do not edit it in
// place. See the TUI plugin note in AGENTS.md for why its imports are allowed.
//
// MIT License
//
// Copyright (c) 2026 Yosua Ian Sebastian
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//

// src/tui.tsx
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { use as _$use } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

// src/activity.ts
function observeActivity(activities, sessionID, label, observedAt) {
  if (!Number.isFinite(observedAt))
    return activities;
  return new Map(activities).set(sessionID, { label, observedAt });
}
function clearActivity(activities, sessionID) {
  if (!activities.has(sessionID))
    return activities;
  return new Map([...activities].filter(([id]) => id !== sessionID));
}
function touchActivity(activities, sessionID, observedAt) {
  const previous = activities.get(sessionID);
  if (!previous || !Number.isFinite(observedAt) || observedAt - previous.observedAt < 1000) {
    return activities;
  }
  return observeActivity(activities, sessionID, previous.label, observedAt);
}
function activityLabel(part, messageRole) {
  if (part.type === "reasoning")
    return "thinking";
  if (part.type === "text" && messageRole === "assistant" && !part.synthetic && !part.ignored)
    return "responding";
  if (part.type === "tool")
    return part.tool;
}
function updateActivity(activities, sessionID, part, observedAt, messageRole) {
  const label = activityLabel(part, messageRole);
  if (!label || !Number.isFinite(observedAt))
    return activities;
  const previous = activities.get(sessionID);
  if (previous && observedAt < previous.observedAt)
    return activities;
  return previous?.label === label ? touchActivity(activities, sessionID, observedAt) : observeActivity(activities, sessionID, label, observedAt);
}

// src/subagent.ts
var ACTIVE = new Set(["busy", "retry"]);
function isActive(status) {
  return status !== undefined && ACTIVE.has(status.type);
}
function normalizeStatus(status) {
  return status && isActive(status) ? status : { type: "idle" };
}
function displayStatus(subagent) {
  if (isActive(subagent.status))
    return subagent.status.type;
  if (subagent.errorAt !== undefined)
    return "error";
  return "idle";
}
function transitionTiming(timing, previous, next, now) {
  const wasActive = isActive(previous);
  const active = isActive(next);
  if (active && !wasActive)
    return { startedAt: now };
  if (!active && wasActive && timing)
    return { ...timing, endedAt: now };
  return timing;
}
function updateStatus(subagent, status, now) {
  const next = normalizeStatus(status);
  const active = isActive(next);
  const timing = transitionTiming(subagent.timing, subagent.status, next, now);
  return {
    ...subagent,
    status: next,
    errorAt: active ? undefined : subagent.errorAt,
    timing
  };
}
function startObservedTiming(subagent, now) {
  if (!isActive(subagent.status) || subagent.timing)
    return subagent;
  return { ...subagent, timing: { startedAt: now } };
}
function retainError(subagent, now) {
  const timing = isActive(subagent.status) && subagent.timing ? { ...subagent.timing, endedAt: now } : subagent.timing;
  return { ...subagent, status: { type: "idle" }, errorAt: now, timing };
}
function cancelSubagent(subagent, now) {
  if (!isActive(subagent.status))
    return subagent;
  return { ...updateStatus(subagent, { type: "idle" }, now), errorAt: undefined };
}

// src/tracker.ts
function isAbortedError(error) {
  return !!error && typeof error === "object" && "name" in error && error.name === "MessageAbortedError";
}
function setRecord(records, record) {
  return new Map(records).set(record.session.id, record);
}
function removeRecord(records, sessionID) {
  return new Map([...records].filter(([id]) => id !== sessionID));
}
function applyLifecycle(records, event) {
  const previous = records.get(event.sessionID);
  if (!previous)
    return new Map(records);
  const next = event.type === "status" ? updateStatus(previous, event.status, event.now) : event.type === "cancel" ? cancelSubagent(previous, event.now) : retainError(previous, event.now);
  return setRecord(records, next);
}
function reconcile(records, parentID, sessions, statuses, pending, now) {
  const retained = [...records].filter(([, record]) => record.session.parentID !== parentID);
  const pendingIDs = new Set(pending.map((event) => event.sessionID));
  const fetched = sessions.filter((session) => session.parentID === parentID).map((session) => {
    const previous = records.get(session.id);
    const status = pendingIDs.has(session.id) ? previous?.status ?? { type: "idle" } : statuses.get(session.id) ?? { type: "idle" };
    const currentSession = previous && previous.session.time.updated > session.time.updated ? previous.session : session;
    const base = previous ? { ...previous, session: currentSession } : { session, status: normalizeStatus(status) };
    const record = previous ? updateStatus(base, status, now) : startObservedTiming(base, now);
    return [session.id, record];
  });
  const baseline = new Map([...retained, ...fetched]);
  return pending.reduce(applyLifecycle, baseline);
}
function currentChildren(records, members) {
  return new Map([...members].map((id) => records.get(id)).filter((record) => record !== undefined).map((record) => [record.session.id, record]));
}

class SubagentTracker {
  options;
  parentID;
  records = new Map;
  members = new Set;
  pending = [];
  deleted = new Map;
  loadState = "loading";
  stale = false;
  parentGeneration = 0;
  listGeneration = 0;
  fetching = false;
  trailing = false;
  timer;
  disposed = false;
  now;
  debounceMs;
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.debounceMs = options.debounceMs ?? 100;
  }
  snapshot() {
    return {
      parentID: this.parentID,
      children: currentChildren(this.records, this.members),
      loadState: this.loadState,
      stale: this.stale
    };
  }
  setParent(parentID) {
    if (this.parentID === parentID)
      return;
    this.parentGeneration++;
    this.listGeneration++;
    this.parentID = parentID;
    this.members = new Set;
    this.pending = [];
    this.loadState = "loading";
    this.stale = false;
    this.trailing = false;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = undefined;
    this.emit();
    this.refresh();
  }
  scheduleRefresh() {
    if (!this.parentID || this.disposed)
      return;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.refresh();
    }, this.debounceMs);
  }
  async refresh() {
    const parentID = this.parentID;
    if (!parentID || this.disposed)
      return;
    if (this.fetching) {
      this.trailing = true;
      return;
    }
    const parentGeneration = this.parentGeneration;
    const listGeneration = this.listGeneration;
    this.fetching = true;
    try {
      const sessions = await this.options.fetchChildren(parentID);
      const staleParent = parentGeneration !== this.parentGeneration || parentID !== this.parentID;
      const staleList = listGeneration !== this.listGeneration;
      if (this.disposed || staleParent || staleList) {
        this.options.log?.("debug", "ignored stale child-session response");
        if (!this.disposed)
          this.trailing = true;
        return;
      }
      const fetched = sessions.filter((session) => session.parentID === parentID);
      const fetchedIDs = new Set(fetched.map((session) => session.id));
      const direct = fetched.filter((session) => this.deleted.get(session.id) !== parentID);
      const statuses = new Map(direct.map((session) => [session.id, normalizeStatus(this.options.status(session.id))]));
      this.records = reconcile(this.records, parentID, direct, statuses, this.pending, this.now());
      this.members = new Set(direct.map((session) => session.id));
      this.pending = [];
      this.deleted = new Map([...this.deleted].filter(([sessionID, ownerID]) => ownerID !== parentID || fetchedIDs.has(sessionID)));
      this.loadState = "ready";
      this.stale = false;
      this.emit();
    } catch {
      if (this.disposed || parentGeneration !== this.parentGeneration || listGeneration !== this.listGeneration) {
        if (!this.disposed)
          this.trailing = true;
        return;
      }
      this.stale = this.loadState === "ready";
      if (!this.stale)
        this.loadState = "unavailable";
      this.options.log?.("warn", "failed to fetch child sessions");
      this.emit();
    } finally {
      this.fetching = false;
      if (this.trailing && !this.disposed) {
        this.trailing = false;
        if (this.timer)
          clearTimeout(this.timer);
        this.timer = undefined;
        this.refresh();
      }
    }
  }
  onCreated(session) {
    this.onSessionChanged(session, true);
  }
  onUpdated(session) {
    this.onSessionChanged(session, false);
  }
  onSessionChanged(session, membershipChanged) {
    const previous = this.records.get(session.id);
    if (session.parentID !== this.parentID && !previous)
      return;
    const visibleBefore = this.members.has(session.id);
    const visibleAfter = session.parentID === this.parentID;
    if (membershipChanged || visibleBefore !== visibleAfter)
      this.listGeneration++;
    const status = this.options.status(session.id);
    const now = this.now();
    const base = previous ? { ...previous, session } : { session, status: normalizeStatus(status) };
    const identified = previous ? updateStatus(base, status, now) : startObservedTiming(base, now);
    const related = this.pending.filter((event) => event.sessionID === session.id);
    this.records = related.reduce(applyLifecycle, setRecord(this.records, identified));
    this.pending = this.pending.filter((event) => event.sessionID !== session.id);
    this.members = session.parentID === this.parentID ? new Set(this.members).add(session.id) : new Set([...this.members].filter((id) => id !== session.id));
    this.emit();
    this.scheduleRefresh();
  }
  onDeleted(session) {
    const relevant = session.parentID === this.parentID || this.records.has(session.id);
    if (!relevant)
      return;
    const visible = this.members.has(session.id);
    this.listGeneration++;
    if (session.parentID)
      this.deleted = new Map(this.deleted).set(session.id, session.parentID);
    this.records = removeRecord(this.records, session.id);
    this.members = new Set([...this.members].filter((id) => id !== session.id));
    if (visible)
      this.emit();
    this.scheduleRefresh();
  }
  onStatus(sessionID, status) {
    const record = this.records.get(sessionID);
    const event = { type: "status", sessionID, status, now: this.now() };
    if (record) {
      this.records = applyLifecycle(this.records, event);
      if (this.members.has(sessionID))
        this.emit();
      if (this.fetching)
        this.pending = [...this.pending, event];
      return;
    }
    if (this.loadState !== "ready" || this.fetching) {
      this.pending = [...this.pending, event];
      this.scheduleRefresh();
    }
  }
  onError(sessionID, error) {
    if (!sessionID || error === undefined) {
      this.options.log?.("warn", "ignored incomplete session.error event");
      return;
    }
    const record = this.records.get(sessionID);
    const event = {
      type: isAbortedError(error) ? "cancel" : "error",
      sessionID,
      now: this.now()
    };
    if (record) {
      this.records = applyLifecycle(this.records, event);
      if (this.members.has(sessionID))
        this.emit();
      if (this.fetching)
        this.pending = [...this.pending, event];
      return;
    }
    if (this.loadState !== "ready" || this.fetching) {
      this.pending = [...this.pending, event];
      this.scheduleRefresh();
    }
  }
  dispose() {
    this.disposed = true;
    this.parentGeneration++;
    if (this.timer)
      clearTimeout(this.timer);
    this.timer = undefined;
  }
  emit() {
    this.options.onChange?.(this.snapshot());
  }
}

// src/terminal-text.ts
var WHITESPACE = /\s+/g;
var EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
var EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
var REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
var EMOJI_VARIATION = /\ufe0f/u;
var KEYCAP = /\u20e3/u;
var FORMAT_CONTROL = /\p{Cf}/u;
var ZERO_WIDTH_ONLY = /^[\p{Mark}\p{Cf}]+$/u;
var EMOJI_JOIN_IGNORABLE = /[\p{Mark}\p{Emoji_Modifier}]/u;
var EMOJI_TAG_SEQUENCE = /^\u{1f3f4}[\u{e0020}-\u{e007e}]+\u{e007f}$/u;
var EMOJI_TAG_CHARACTER = /[\u{e0020}-\u{e007f}]/u;
var SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function sanitizeText(value) {
  return [...SEGMENTER.segment(value)].flatMap(({ segment }) => {
    const characters = [...segment];
    const emojiTagSequence = EMOJI_TAG_SEQUENCE.test(segment);
    const joinedPictographs = (index) => {
      const neighbor = (direction) => {
        let cursor = index + direction;
        while (characters[cursor] && EMOJI_JOIN_IGNORABLE.test(characters[cursor]))
          cursor += direction;
        return characters[cursor];
      };
      const previous = neighbor(-1);
      const next = neighbor(1);
      return !!previous && !!next && EXTENDED_PICTOGRAPHIC.test(previous) && EXTENDED_PICTOGRAPHIC.test(next);
    };
    return characters.filter((character, index) => {
      const code = character.codePointAt(0) ?? 0;
      const control = code <= 8 || code >= 11 && code <= 31 || code >= 127 && code <= 159;
      if (control)
        return false;
      if (character === "‍")
        return joinedPictographs(index);
      if (EMOJI_TAG_CHARACTER.test(character))
        return emojiTagSequence;
      return !FORMAT_CONTROL.test(character);
    });
  }).join("").replace(WHITESPACE, " ").trim();
}
function isWide(codePoint) {
  return codePoint >= 4352 && (codePoint <= 4447 || codePoint === 9001 || codePoint === 9002 || codePoint >= 11904 && codePoint <= 42191 && codePoint !== 12351 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65040 && codePoint <= 65049 || codePoint >= 65072 && codePoint <= 65135 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 131072 && codePoint <= 262141);
}
function displayWidth(value) {
  return [...SEGMENTER.segment(value)].reduce((width, { segment }) => {
    if (ZERO_WIDTH_ONLY.test(segment))
      return width;
    const emoji = EMOJI_PRESENTATION.test(segment) || REGIONAL_INDICATOR.test(segment) || EMOJI_VARIATION.test(segment) || KEYCAP.test(segment);
    return width + (emoji || isWide(segment.codePointAt(0) ?? 0) ? 2 : 1);
  }, 0);
}
function truncateWidth(value, width) {
  if (width <= 0)
    return "";
  if (displayWidth(value) <= width)
    return value;
  if (width === 1)
    return "…";
  const limit = width - 1;
  const { result } = [...SEGMENTER.segment(value)].map(({ segment }) => segment).reduce((state, segment) => state.done || displayWidth(state.result + segment) > limit ? { ...state, done: true } : { result: state.result + segment, done: false }, { result: "", done: false });
  return result + "…";
}

// src/sidebar.ts
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function displayTitle(session) {
  const full = sanitizeText(session.title);
  if (!session.agent)
    return full;
  const stripped = full.replace(new RegExp(`\\s+\\(@${escapeRegExp(session.agent)} subagent\\)$`), "").trim();
  return stripped || full;
}
function modelsEqual(left, right) {
  if (!left || !right)
    return left === right;
  return left.providerID === right.providerID && left.id === right.id;
}
function resolveSessionModel(session, messages) {
  if (session?.model)
    return session.model;
  const message = messages.findLast((item) => item.role === "user");
  if (!message)
    return;
  return {
    providerID: message.model.providerID,
    id: message.model.modelID,
    variant: message.model.variant
  };
}
function differingModel(child, parent) {
  if (!child || modelsEqual(child, parent))
    return;
  return `${child.providerID}/${child.id}`;
}
function byID(left, right) {
  return left.session.id.localeCompare(right.session.id);
}
function sortAndPrune(children, limit = 5) {
  const values = [...children];
  const active = values.filter((child) => isActive(child.status)).toSorted((left, right) => left.session.time.created - right.session.time.created || byID(left, right));
  const errors = values.filter((child) => displayStatus(child) === "error").toSorted((left, right) => (right.errorAt ?? 0) - (left.errorAt ?? 0) || byID(left, right));
  const idle = values.filter((child) => displayStatus(child) === "idle").toSorted((left, right) => right.session.time.updated - left.session.time.updated || byID(left, right));
  const sorted = [...active, ...errors, ...idle];
  return {
    visible: sorted.slice(0, limit),
    omitted: Math.max(0, sorted.length - limit)
  };
}
function formatDuration(timing, now) {
  if (!timing)
    return;
  const seconds = Math.max(0, Math.floor(((timing.endedAt ?? now) - timing.startedAt) / 1000));
  let value;
  if (seconds < 60)
    value = `${seconds}s`;
  else if (seconds < 3600)
    value = `${Math.floor(seconds / 60)}m`;
  else {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    value = minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return value;
}
function formatCost(cost) {
  if (!cost || cost <= 0 || !Number.isFinite(cost))
    return;
  if (cost < 0.01)
    return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
function summarize(children) {
  return [...children].reduce((summary, child) => {
    const status = displayStatus(child);
    return {
      total: summary.total + 1,
      active: summary.active + (status === "busy" || status === "retry" ? 1 : 0),
      errors: summary.errors + (status === "error" ? 1 : 0)
    };
  }, { total: 0, active: 0, errors: 0 });
}
function headerLine(summary, collapsed, width, stale = false) {
  const arrow = collapsed ? "▶" : "▼";
  if (summary.total === 0 && !stale)
    return truncateWidth(`${arrow} Subagents · none`, width);
  const counts = [
    summary.active ? `${summary.active} active` : "",
    summary.errors ? `${summary.errors} error` : "",
    `${summary.total} total`,
    stale ? "stale" : ""
  ].filter(Boolean);
  return truncateWidth(`${arrow} Subagents · ${counts.join(" · ")}`, width);
}
function headerSegments(summary, collapsed, width, stale = false) {
  return headerLine(summary, collapsed, width, stale).split(" · ");
}
function formatActivity(activity, now) {
  if (!activity)
    return;
  const age = formatDuration({ startedAt: activity.observedAt, endedAt: now }, now);
  const label = sanitizeText(activity.label);
  if (!label || !age)
    return;
  return { label, age: `${age} ago` };
}
function fitFields(fields, width) {
  const values = fields.filter(Boolean);
  const line = values.length ? `  ${values.join(" · ")}` : "";
  return line && displayWidth(line) <= width ? line : undefined;
}
function fitActivityColumns(activity, duration, width) {
  const separator = "  ";
  const activityWidth = width - displayWidth(`  ${separator}${duration}`);
  const labelWidth = activityWidth - displayWidth(` ${activity.age}`);
  if (labelWidth <= 0)
    return;
  const label = truncateWidth(activity.label, labelWidth);
  if (!label || label === "…" && activity.label !== "…")
    return;
  const field = `${label} ${activity.age}`;
  return `  ${field}${" ".repeat(Math.max(0, activityWidth - displayWidth(field)))}${separator}${duration}`;
}
function fitActivityOnly(activity, width) {
  const labelWidth = width - displayWidth(`   ${activity.age}`);
  if (labelWidth > 0) {
    const label = truncateWidth(activity.label, labelWidth);
    if (label !== "…" || activity.label === "…")
      return `  ${label} ${activity.age}`;
  }
  return fitFields([activity.age], width);
}
function fitActiveDetails(activity, runtime, width, now) {
  const observed = formatActivity(activity, now);
  if (!observed) {
    const duration2 = runtime ? `dur ${runtime}` : undefined;
    return fitFields([duration2 ?? ""], width);
  }
  const duration = runtime ? `dur ${runtime}` : undefined;
  if (duration) {
    return fitActivityColumns(observed, duration, width) ?? fitActivityOnly(observed, width);
  }
  return fitActivityOnly(observed, width);
}
function fitIdentity(agent, model, width) {
  if (!agent)
    return model && width > 2 ? `  ${truncateWidth(model, width - 2)}` : undefined;
  const full = model ? fitFields([agent, model], width) : fitFields([agent], width);
  if (full)
    return full;
  if (!model)
    return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
  const modelPrefix = " · ";
  const modelWidth = width - displayWidth(`  ${agent}${modelPrefix}`);
  if (modelWidth > 0)
    return `  ${agent}${modelPrefix}${truncateWidth(model, modelWidth)}`;
  return width > 2 ? `  ${truncateWidth(agent, width - 2)}` : undefined;
}
function fitSettledDetails(runtime, cost, width) {
  const duration = runtime ? `dur ${runtime}` : undefined;
  return fitFields([duration ?? "", cost ?? ""], width) ?? fitFields([duration ?? ""], width) ?? fitFields([cost ?? ""], width);
}
function rowLines(child, parentModel, width, now, activity) {
  const status = displayStatus(child);
  const symbol = {
    busy: "*",
    retry: "~",
    error: "!",
    idle: "-"
  };
  const fullTitle = displayTitle(child.session);
  const statusPrefix = `${symbol[status]} ${status}`;
  const fullPrefix = `${symbol[status]} ${status} · `;
  const showTitle = !!fullTitle && displayWidth(fullPrefix) < width;
  const prefix = showTitle ? fullPrefix : truncateWidth(statusPrefix, width);
  const title = showTitle ? truncateWidth(fullTitle, width - displayWidth(fullPrefix)) : "";
  const first = prefix + title;
  const agent = sanitizeText(child.session.agent ?? "");
  const runtime = formatDuration(child.timing, now);
  const cost = formatCost(child.session.cost);
  const model = sanitizeText(differingModel(child.session.model, parentModel) ?? "") || undefined;
  const second = isActive(child.status) ? fitActiveDetails(activity, runtime, width, now) : fitSettledDetails(runtime, cost, width);
  const third = fitIdentity(agent, model, width);
  return { first: truncateWidth(first, width), prefix, title, second, third };
}

// src/tui.tsx
var PLUGIN_ID = "opencode-subagent-watch";
var COLLAPSED_KEY = `${PLUGIN_ID}.collapsed`;
function log(api, level, message) {
  api.client.app.log({
    service: PLUGIN_ID,
    level,
    message
  }).catch(() => {});
}
function navigate(api, sessionID) {
  api.ui.dialog.clear();
  api.route.navigate("session", {
    sessionID
  });
}
function statusColor(api, status) {
  if (status === "error")
    return api.theme.current.error;
  if (status === "retry")
    return api.theme.current.warning;
  if (status === "busy")
    return api.theme.current.success;
  return api.theme.current.textMuted;
}
function View(props) {
  const [width, setWidth] = createSignal(40);
  const [now, setNow] = createSignal(Date.now());
  const [hovered, setHovered] = createSignal();
  let root;
  createEffect(() => props.ensureKV());
  if (props.snapshot().parentID === props.sessionID)
    props.tracker.refresh();
  else
    props.tracker.setParent(props.sessionID);
  const list = createMemo(() => sortAndPrune(props.snapshot().children.values()));
  createEffect(() => {
    const hoveredID = hovered();
    if (hoveredID && (props.collapsed() || !list().visible.some((child) => child.session.id === hoveredID))) {
      setHovered(undefined);
    }
  });
  const parentModel = createMemo(() => resolveSessionModel(props.api.state.session.get(props.sessionID), props.api.state.session.messages(props.sessionID)));
  const summary = createMemo(() => summarize(props.snapshot().children.values()));
  const header = createMemo(() => headerSegments(summary(), props.collapsed(), width(), props.snapshot().stale));
  const headerColor = (segment) => {
    if (segment.endsWith(" active"))
      return props.api.theme.current.success;
    if (segment.endsWith(" error"))
      return props.api.theme.current.error;
    return props.api.theme.current.textMuted;
  };
  createEffect(() => {
    const hasVisibleActive = list().visible.some((child) => isActive(child.status));
    if (!hasVisibleActive || props.collapsed())
      return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });
  const measure = () => {
    if (root?.width)
      setWidth(Math.max(1, root.width));
  };
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$use((value) => {
      root = value;
      queueMicrotask(measure);
    }, _el$);
    _$setProp(_el$, "onSizeChange", measure);
    _$setProp(_el$, "width", "100%");
    _$setProp(_el$, "flexDirection", "column");
    _$insertNode(_el$2, _el$3);
    _$setProp(_el$2, "width", "100%");
    _$insert(_el$3, _$createComponent(Show, {
      get when() {
        return props.snapshot().loadState === "ready";
      },
      get fallback() {
        return (() => {
          var _el$0 = _$createElement("span"), _el$1 = _$createElement("b");
          _$insertNode(_el$0, _el$1);
          _$insert(_el$1, () => truncateWidth(`${props.collapsed() ? "▶" : "▼"} Subagents`, width()));
          _$effect((_$p) => _$setProp(_el$0, "style", {
            fg: props.api.theme.current.text
          }, _$p));
          return _el$0;
        })();
      },
      get children() {
        return [(() => {
          var _el$4 = _$createElement("span"), _el$5 = _$createElement("b");
          _$insertNode(_el$4, _el$5);
          _$insert(_el$5, () => header()[0]);
          _$effect((_$p) => _$setProp(_el$4, "style", {
            fg: props.api.theme.current.text
          }, _$p));
          return _el$4;
        })(), _$createComponent(For, {
          get each() {
            return header().slice(1);
          },
          children: (segment) => [(() => {
            var _el$10 = _$createElement("span");
            _$insertNode(_el$10, _$createTextNode(` · `));
            _$effect((_$p) => _$setProp(_el$10, "style", {
              fg: props.api.theme.current.textMuted
            }, _$p));
            return _el$10;
          })(), (() => {
            var _el$12 = _$createElement("span");
            _$insert(_el$12, segment);
            _$effect((_$p) => _$setProp(_el$12, "style", {
              fg: headerColor(segment)
            }, _$p));
            return _el$12;
          })()]
        })];
      }
    }));
    _$insert(_el$, _$createComponent(Show, {
      get when() {
        return !props.collapsed();
      },
      get children() {
        return [_$createComponent(Show, {
          get when() {
            return props.snapshot().loadState === "loading";
          },
          get children() {
            var _el$6 = _$createElement("text");
            _$insert(_el$6, () => truncateWidth("  Loading subagents…", width()));
            _$effect((_$p) => _$setProp(_el$6, "fg", props.api.theme.current.textMuted, _$p));
            return _el$6;
          }
        }), _$createComponent(Show, {
          get when() {
            return props.snapshot().loadState === "unavailable";
          },
          get children() {
            var _el$7 = _$createElement("text");
            _$insert(_el$7, () => truncateWidth("  Subagents unavailable", width()));
            _$effect((_$p) => _$setProp(_el$7, "fg", props.api.theme.current.error, _$p));
            return _el$7;
          }
        }), _$createComponent(Show, {
          get when() {
            return _$memo(() => props.snapshot().loadState === "ready")() && props.snapshot().children.size === 0;
          },
          get children() {
            var _el$8 = _$createElement("text");
            _$insert(_el$8, () => truncateWidth("  No subagents", width()));
            _$effect((_$p) => _$setProp(_el$8, "fg", props.api.theme.current.textMuted, _$p));
            return _el$8;
          }
        }), _$createComponent(For, {
          get each() {
            return list().visible;
          },
          children: (child) => {
            const isHovered = () => hovered() === child.session.id;
            const status = () => displayStatus(child);
            const lines = () => rowLines(child, parentModel(), width(), now(), props.activities().get(child.session.id));
            return (() => {
              var _el$13 = _$createElement("box"), _el$14 = _$createElement("text"), _el$15 = _$createElement("span"), _el$17 = _$createElement("span");
              _$insertNode(_el$13, _el$14);
              _$setProp(_el$13, "width", "100%");
              _$setProp(_el$13, "flexDirection", "column");
              _$setProp(_el$13, "onMouseOver", () => setHovered(child.session.id));
              _$setProp(_el$13, "onMouseOut", () => setHovered(undefined));
              _$setProp(_el$13, "onMouseUp", () => navigate(props.api, child.session.id));
              _$insertNode(_el$14, _el$15);
              _$insertNode(_el$14, _el$17);
              _$insert(_el$15, _$createComponent(Show, {
                get when() {
                  return isHovered();
                },
                get fallback() {
                  return lines().prefix;
                },
                get children() {
                  var _el$16 = _$createElement("b");
                  _$insert(_el$16, () => lines().prefix);
                  return _el$16;
                }
              }));
              _$insert(_el$17, () => lines().title);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return lines().second;
                },
                keyed: true,
                children: (second) => (() => {
                  var _el$18 = _$createElement("text");
                  _$insert(_el$18, second);
                  _$effect((_$p) => _$setProp(_el$18, "fg", isHovered() ? props.api.theme.current.text : props.api.theme.current.textMuted, _$p));
                  return _el$18;
                })()
              }), null);
              _$insert(_el$13, _$createComponent(Show, {
                get when() {
                  return lines().third;
                },
                keyed: true,
                children: (third) => (() => {
                  var _el$19 = _$createElement("text");
                  _$insert(_el$19, third);
                  _$effect((_$p) => _$setProp(_el$19, "fg", isHovered() ? props.api.theme.current.text : props.api.theme.current.textMuted, _$p));
                  return _el$19;
                })()
              }), null);
              _$effect((_p$) => {
                var _v$ = {
                  fg: isHovered() && status() === "idle" ? props.api.theme.current.text : statusColor(props.api, status())
                }, _v$2 = {
                  fg: isHovered() ? props.api.theme.current.text : props.api.theme.current.textMuted
                };
                _v$ !== _p$.e && (_p$.e = _$setProp(_el$15, "style", _v$, _p$.e));
                _v$2 !== _p$.t && (_p$.t = _$setProp(_el$17, "style", _v$2, _p$.t));
                return _p$;
              }, {
                e: undefined,
                t: undefined
              });
              return _el$13;
            })();
          }
        }), _$createComponent(Show, {
          get when() {
            return list().omitted > 0;
          },
          get children() {
            var _el$9 = _$createElement("text");
            _$insert(_el$9, () => truncateWidth(`  ${list().omitted} more subagents omitted`, width()));
            _$effect((_$p) => _$setProp(_el$9, "fg", props.api.theme.current.textMuted, _$p));
            return _el$9;
          }
        })];
      }
    }), null);
    _$effect((_$p) => _$setProp(_el$2, "onMouseUp", props.toggle, _$p));
    return _el$;
  })();
}
var tui = async (api) => {
  const [snapshot, setSnapshot] = createSignal({
    children: new Map,
    loadState: "loading",
    stale: false
  });
  const [collapsed, setCollapsed] = createSignal(false);
  const [activities, setActivities] = createSignal(new Map);
  let kvLoaded = false;
  const tracker = new SubagentTracker({
    fetchChildren: async (parentID) => {
      const response = await api.client.session.children({
        sessionID: parentID
      });
      if (response.error)
        throw response.error;
      return response.data ?? [];
    },
    status: (sessionID) => api.state.session.status(sessionID),
    onChange: setSnapshot,
    log: (level, message) => log(api, level, message)
  });
  const ensureKV = () => {
    if (kvLoaded || !api.kv.ready)
      return;
    kvLoaded = true;
    setCollapsed(api.kv.get(COLLAPSED_KEY, false));
  };
  const toggle = () => {
    ensureKV();
    if (!api.kv.ready) {
      setCollapsed(false);
      return;
    }
    const next = !collapsed();
    setCollapsed(next);
    if (api.kv.ready)
      api.kv.set(COLLAPSED_KEY, next);
  };
  api.lifecycle.onDispose(() => tracker.dispose());
  api.event.on("session.created", (event) => tracker.onCreated(event.properties.info));
  api.event.on("session.updated", (event) => tracker.onUpdated(event.properties.info));
  api.event.on("session.deleted", (event) => {
    tracker.onDeleted(event.properties.info);
    setActivities((value) => clearActivity(value, event.properties.sessionID));
  });
  api.event.on("session.status", (event) => {
    tracker.onStatus(event.properties.sessionID, event.properties.status);
    if (event.properties.status.type === "idle") {
      setActivities((value) => clearActivity(value, event.properties.sessionID));
    }
  });
  api.event.on("session.error", (event) => {
    tracker.onError(event.properties.sessionID, event.properties.error);
    if (event.properties.sessionID && event.properties.error) {
      setActivities((value) => clearActivity(value, event.properties.sessionID));
    }
  });
  api.event.on("message.part.updated", (event) => {
    const {
      sessionID,
      part,
      time
    } = event.properties;
    const child = snapshot().children.get(sessionID);
    if (!child || !isActive(child.status))
      return;
    const messageRole = part.type === "text" ? api.state.session.messages(sessionID).findLast((message) => message.id === part.messageID)?.role : undefined;
    const current = activities();
    const next = updateActivity(current, sessionID, part, time, messageRole);
    if (next !== current)
      setActivities(next);
  });
  api.slots.register({
    order: 450,
    slots: {
      sidebar_content(_context, props) {
        return _$createComponent(View, {
          api,
          get sessionID() {
            return props.session_id;
          },
          tracker,
          snapshot,
          collapsed,
          activities,
          toggle,
          ensureKV
        });
      }
    }
  });
  log(api, "debug", "activated");
};
var plugin = {
  id: PLUGIN_ID,
  tui
};
var tui_default = plugin;
export {
  tui_default as default
};
