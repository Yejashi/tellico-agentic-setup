// Measures what prompts/orchestrate.md can only ask for: that the lead keeps
// both servers busy. Counts task dispatches and their overlap, and when the
// lead wastes a node it pushes one line into the next system prompt.
//
// Why a plugin and not more prose. The whole point of this setup is two
// servers running at once, and the three ways to lose that are invisible to
// the lead itself: dispatching serially, pinning both halves of a pair to one
// node, and pairing a long task with a short one. Prose asks for all three on
// every turn and pays tokens for it whether or not the lead is getting it
// right. Here the cost is paid only when something actually went wrong.
//
// It only ever nudges, once per kind per session, and never throws: a wrong
// count must not be able to break a session. Workers cannot call task (the
// lead's permission block denies it), so every dispatch seen here is the
// lead's.

const WORKER_NODE_RE = /^tellico-worker-([01])$/;

// A long task beside a short one idles a server for the difference. Below
// this the batch is too short for the imbalance to be worth a line.
const IMBALANCE_MIN_MS = 20000;
const IMBALANCE_RATIO = 3;

// Two dispatches that each ran alone is a pattern; one is a judgement call
// the lead is allowed to make.
const SOLO_RUN_LIMIT = 2;

function stateFor(states, sessionID) {
  let state = states.get(sessionID);
  if (!state) {
    state = {
      inflight: new Map(),
      soloRun: 0,
      lastPaired: null,
      fired: new Set(),
      pending: [],
    };
    states.set(sessionID, state);
  }
  return state;
}

function nudge(state, kind, line) {
  if (state.fired.has(kind)) return;
  state.fired.add(kind);
  state.pending.push(line);
}

function agentOf(args) {
  if (!args || typeof args !== "object") return "";
  const value = args.subagent_type || args.agent || args.agentName;
  return typeof value === "string" ? value : "";
}

function otherNode(agent) {
  const match = WORKER_NODE_RE.exec(agent);
  if (!match) return null;
  return match[1] === "0" ? "tellico-worker-1" : "tellico-worker-0";
}

export const DispatchBalancePlugin = async () => {
  const states = new Map();

  return {
    "tool.execute.before": async (input, output) => {
      try {
        if (!input || input.tool !== "task" || !input.sessionID) return;
        const state = stateFor(states, input.sessionID);
        const agent = agentOf(output && output.args);

        // Both halves of a pair on one server run at half speed each for no
        // aggregate gain, and leave the other server with nothing.
        for (const entry of state.inflight.values()) {
          if (entry.agent && entry.agent === agent) {
            const other = otherNode(agent);
            if (other) {
              nudge(
                state,
                "same-node",
                `Dispatch: two tasks are in flight on ${agent} at once, so ` +
                  `the other server is idle and both halves run at half ` +
                  `speed. Send one of a concurrent pair to ${other}.`,
              );
            }
          }
        }

        // Every task already running has now overlapped at least one other.
        for (const entry of state.inflight.values()) entry.overlapped = true;

        state.inflight.set(input.callID, {
          agent,
          start: Date.now(),
          overlapped: state.inflight.size > 0,
        });
      } catch {
        // Accounting is never worth failing a dispatch over.
      }
    },

    "tool.execute.after": async (input) => {
      try {
        if (!input || input.tool !== "task" || !input.sessionID) return;
        const state = states.get(input.sessionID);
        if (!state) return;

        const entry = state.inflight.get(input.callID);
        if (!entry) return;
        state.inflight.delete(input.callID);

        const duration = Date.now() - entry.start;

        if (entry.overlapped) {
          state.soloRun = 0;
          // Pair halves of similar expected cost: a batch ends only when its
          // slowest member ends.
          const partner = state.lastPaired;
          if (
            partner &&
            Math.max(duration, partner) >= IMBALANCE_MIN_MS &&
            Math.max(duration, partner) > Math.min(duration, partner) * IMBALANCE_RATIO
          ) {
            nudge(
              state,
              "imbalance",
              `Dispatch: that batch's halves took ${Math.round(partner / 1000)}s ` +
                `and ${Math.round(duration / 1000)}s, so one server idled for ` +
                `most of it. Pair halves of similar expected cost, or put the ` +
                `small half's work in your own tool-call batch beside the large one.`,
            );
          }
          state.lastPaired = duration;
          return;
        }

        state.lastPaired = null;
        state.soloRun += 1;
        if (state.soloRun >= SOLO_RUN_LIMIT) {
          nudge(
            state,
            "serial",
            `Dispatch: the last ${state.soloRun} tasks each ran alone, so one ` +
              `server was idle throughout. Before the next dispatch, name two ` +
              `independent units and emit both task calls in one tool-call ` +
              `batch; if the work genuinely will not divide, say so in one line.`,
          );
        }
      } catch {
        // As above.
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!input || !input.sessionID || !output || !Array.isArray(output.system)) return;
        const state = states.get(input.sessionID);
        if (!state || state.pending.length === 0) return;
        for (const line of state.pending) output.system.push(line);
        state.pending = [];
      } catch {
        // As above.
      }
    },
  };
};

export default DispatchBalancePlugin;
