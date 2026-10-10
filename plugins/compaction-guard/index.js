// Keeps the session's own overhead calls -- compaction, summary, title -- from
// thinking, so a summary cannot spend its output budget on reasoning and come
// back truncated.
//
// Why this matters. When compaction is asked for a summary and the answer hits
// the output cap, OpenCode has no fallback: SessionCompaction.process returns
// "stop" the moment that message carries an error, the turn ends, and every
// following turn tries the same compaction and fails the same way. The session
// is finished, mid-task, with no way forward but a new one. The summary itself
// is a form-filling job -- eight fixed headings of terse bullets -- and the
// measured ones on this model run 600 to 7,400 output tokens *with* thinking
// on. Thinking is the whole variance, and it buys nothing here.
//
// Why not config alone. config/opencode.json does set
// agent.compaction.options.chat_template_kwargs.enable_thinking, and that is
// what runs when nobody asked for a thinking level. But a model variant is
// merged *after* agent options (LLMRequestPrep: provider, then model.options,
// then agent.options, then the variant), and compaction inherits the variant
// from the user message that triggered it -- which is the lead's. So under
// "opencode-tellico --think xhigh" the session's own bookkeeping would think
// at xhigh too. chat.params is the last hook before the request goes out and
// carries the agent name, which is the only place that can win.
//
// Scope. Only the three native overhead agents. The lead and the workers are
// untouched: --think and /think-* mean exactly what they say for the work
// itself, and only for the work itself.
//
// OpenCode 2 has no verified counterpart to chat.params, so setup() is a
// deliberate no-op; there, the agent.compaction.options entry in
// config/opencode.json is the whole of this. See AGENTS.md.

const OVERHEAD_AGENTS = new Set(["compaction", "summary", "title"]);

// A fresh kwargs object every time: the one on the way through is merged from
// the provider, model and agent options and may still be shared with them.
function withoutThinking(options) {
  const kwargs = { ...(options.chat_template_kwargs || {}) };
  delete kwargs.reasoning_effort;
  kwargs.enable_thinking = false;
  return { ...options, chat_template_kwargs: kwargs };
}

function guard(input, output) {
  try {
    if (!input || !output) return;
    if (!OVERHEAD_AGENTS.has(input.agent)) return;
    output.options = withoutThinking(output.options || {});
  } catch {
    // A session must never die of its own bookkeeping. Leaving the request as
    // it was is the status quo, not a new failure.
  }
}

// OpenCode 1: a server function that returns hook objects.
export const CompactionGuardPlugin = async () => {
  return {
    "chat.params": async (input, output) => {
      guard(input, output);
    },
  };
};

// OpenCode 2: nothing to register, for now. Returning a disposer keeps the
// shape the other plugins have, so adding a hook here later is a one-liner.
async function setup() {
  return async () => {};
}

export default {
  id: "tellico-compaction-guard",
  server: CompactionGuardPlugin,
  setup,
};
