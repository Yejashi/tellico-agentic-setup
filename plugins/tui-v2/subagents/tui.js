// Subagents panel for OpenCode 2's session sidebar: one row per subagent of
// the session on screen, running ones first, and a click opens that
// subagent's session so its progress can be read.
//
// OpenCode 1 gets the vendored plugins/tui/subagent-watch.js instead. That
// panel is written against OpenCode 1's TUI API ({ id, tui }) and has no
// OpenCode 2 release, so this is a small port of the part that matters --
// listing and opening workers -- onto OpenCode 2's contract:
//
//   - a TUI plugin is a directory whose `tui.js` default-exports
//     { id, setup(context) }; bin/opencode-tellico adds it to the `plugins`
//     list of OpenCode 2's CLI config through OPENCODE_CLI_CONFIG_CONTENT;
//   - context.ui.slot({ append: "sidebar.content", render }) places it, the
//     same call OpenCode's own sidebar widgets make;
//   - context.data.session is a reactive store -- family(id) is the session
//     tree, status(id) is "running" / "idle", get(id) the record -- so the
//     list follows the sessions without polling;
//   - context.ui.router.navigate({ type: "session", sessionID }) opens one.
//
// Plain JavaScript in Solid's compiled form, like the vendored panel, because
// OpenCode loads it with its own runtime: no build step, and only the
// specifiers OpenCode maps for plugins (@opentui/solid, solid-js). It must
// never throw into the TUI: anything unexpected renders nothing instead.

import {
  createComponent,
  createElement,
  effect,
  insert,
  insertNode,
  setProp,
} from "@opentui/solid";
import { createMemo, createSignal, For, Show } from "solid-js";

const ID = "tellico.subagents";
const MAX_ROWS = 8;

function safe(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

function color(theme, name) {
  return safe(() => {
    if (name === "running") return theme.text.feedback.success.base;
    if (name === "error") return theme.text.feedback.error.base;
    if (name === "muted") return theme.text.muted;
    return theme.text.base;
  }, undefined);
}

function truncate(text, width) {
  const value = String(text || "");
  if (width <= 1 || value.length <= width) return value;
  return value.slice(0, Math.max(0, width - 1)) + "…";
}

// "Investigate the cache (@tellico-worker-1 subagent)" -> worker name and task.
function describe(session) {
  const title = safe(() => session.title, "") || "";
  const match = /\(@([^\s)]+)[^)]*\)\s*$/.exec(title);
  const agent = match ? match[1] : safe(() => session.agent, "") || "";
  const task = match ? title.slice(0, match.index).trim() : title;
  return { agent, task };
}

function children(data, sessionID) {
  return safe(() => {
    const family = data.session.family(sessionID) || [];
    const direct = [];
    const others = [];
    for (const id of family) {
      if (id === sessionID) continue;
      const parent = safe(() => {
        const record = data.session.get(id);
        return record && (record.parentID ?? record.parent_id);
      }, undefined);
      if (parent === sessionID) direct.push(id);
      else others.push(id);
    }
    // Prefer direct children; if the record shape hides parents, show the
    // whole family rather than nothing.
    return direct.length ? direct : others;
  }, []);
}

function Panel(props) {
  const { context } = props;
  const [hovered, setHovered] = createSignal();

  const rows = createMemo(() => {
    const ids = children(context.data, props.sessionID);
    const list = ids.map((id) => {
      const status = safe(() => context.data.session.status(id), "idle");
      const record = safe(() => context.data.session.get(id), undefined);
      return { id, status, ...describe(record) };
    });
    // Running first, then newest first by id, which sorts by creation time.
    list.sort((a, b) =>
      a.status === "running" && b.status !== "running" ? -1
        : b.status === "running" && a.status !== "running" ? 1
          : a.id < b.id ? 1 : -1);
    return list;
  });
  const running = createMemo(() => rows().filter((row) => row.status === "running").length);

  function open(sessionID) {
    try {
      context.ui.router.navigate({ type: "session", sessionID });
    } catch {
      // Opening a row is a convenience; never let it break the sidebar.
    }
  }

  return createComponent(Show, {
    get when() {
      return rows().length > 0;
    },
    get children() {
      const box = createElement("box");
      setProp(box, "width", "100%");
      setProp(box, "flexDirection", "column");

      const header = createElement("text");
      insertNode(box, header);
      insert(header, () => {
        const n = rows().length;
        const active = running();
        return `Subagents  ${n}${active ? ` · ${active} running` : ""}`;
      });
      effect((prev) => setProp(header, "fg", color(context.theme, "text"), prev));

      insert(box, createComponent(For, {
        get each() {
          return rows().slice(0, MAX_ROWS);
        },
        children: (row) => {
          const line = createElement("box");
          setProp(line, "width", "100%");
          setProp(line, "flexDirection", "column");
          setProp(line, "onMouseOver", () => setHovered(row.id));
          setProp(line, "onMouseOut", () => setHovered(undefined));
          setProp(line, "onMouseUp", () => open(row.id));

          const first = createElement("text");
          insertNode(line, first);
          insert(first, () => {
            const mark = row.status === "running" ? "●" : "○";
            const name = row.agent || "subagent";
            return truncate(`${mark} ${name} · ${row.status}`, 38);
          });
          effect((prev) => setProp(first, "fg",
            hovered() === row.id ? color(context.theme, "text")
              : row.status === "running" ? color(context.theme, "running")
                : color(context.theme, "muted"), prev));

          const second = createElement("text");
          insertNode(line, second);
          insert(second, () => truncate(`  ${row.task || row.id}`, 38));
          effect((prev) => setProp(second, "fg",
            hovered() === row.id ? color(context.theme, "text") : color(context.theme, "muted"), prev));
          return line;
        },
      }), null);

      const more = createElement("text");
      insert(box, createComponent(Show, {
        get when() {
          return rows().length > MAX_ROWS;
        },
        get children() {
          insert(more, () => `  ${rows().length - MAX_ROWS} more`);
          effect((prev) => setProp(more, "fg", color(context.theme, "muted"), prev));
          return more;
        },
      }), null);
      return box;
    },
  });
}

export default {
  id: ID,
  setup(context) {
    try {
      const dispose = context.ui.slot({
        append: "sidebar.content",
        render: (input) => {
          try {
            return Panel({
              context,
              get sessionID() {
                return input.sessionID;
              },
            });
          } catch {
            return null;
          }
        },
      });
      return () => {
        try {
          if (typeof dispose === "function") dispose();
        } catch {
          // Shutting down.
        }
      };
    } catch {
      return undefined;
    }
  },
};
