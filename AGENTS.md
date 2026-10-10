# AGENTS.md

Client-side setup that points OpenCode at two self-hosted Qwen3.8-27B servers
(GSQ-RCO IQ3_S, with a DFlash2 drafter) on the Tellico cluster. This repo installs files onto the client device; it does not
run the servers.

## Commands

- `./doctor.sh` — check everything the client needs, in dependency order. Run
  this first when something is broken. Its `installed` line reports whether the
  installed copies still match this checkout; a `stale:` or `absent:` there
  means something was changed here and never installed.
- `./install.sh --no-start` — install files only. Use this when a session is
  live: plain `./install.sh` restarts the SSH tunnel and drops it.
- `./install.sh` — full install, including tunnel restart and validation.
- `sh -n <script>` — syntax check. There is no test suite and no CI.
- `python3 -m json.tool config/opencode.json` — validate the config before
  installing it.
- `opencode debug config` — show the config OpenCode actually resolved.
- `tellico-qwen-tunnel status` / `doctor` — check the live tunnel.
- `gateway/install-gateway.sh` — install the API gateway on this host. Safe
  while a session is live: it never restarts the tunnel.
- `tellico-gateway status` / `doctor` / `logs` — check the live gateway.
- `python3 -m py_compile gateway/tellico_gateway.py` — syntax check the gateway.

`shellcheck -s sh` is the intended linter and the scripts carry
`# shellcheck disable=` directives, but it is not installed here. Do not claim a
shellcheck result without running it.

## Hard constraints

Every shell script here is `#!/bin/sh`. Write POSIX shell, not bash: no arrays,
no `[[ ]]`, no `local`, no `${var,,}`. The cluster-side repo (`qwen38-cluster`)
is bash and its nodes run bash 4.2 — keep the two straight.

`plugins/` and `gateway/tellico_gateway.py` are the two exceptions.

The plugins are plain ES-module JavaScript with no imports beyond node's own
builtins. Keep them that way: OpenCode loads them with its own bundled runtime,
so there is no npm install, no build step and no node on the client, and
`install.sh` only has to copy the files. A TypeScript plugin, or one with a
dependency, would mean a toolchain on every client device. They must also never
throw except where a throw is the point: a bug in a plugin that runs on every
tool call would break every session.

The server plugins must load under both OpenCode 1 and OpenCode 2, which
differ in three ways that each silently disable a plugin. OpenCode 2 refuses a
bare file ("configured plugin path must be a directory"), so each plugin is a
directory, `plugins/<name>/index.js` plus a `package.json`, which OpenCode 1
also accepts. OpenCode 1 reads `server` from the default export and OpenCode 2
reads `setup`, so the default export carries both: `{ id, server, setup }`,
with the logic shared and only the wiring duplicated. And OpenCode 2 renamed
the tools and arguments the plugins key on: `bash` is `shell`, `task` is
`subagent` with `agent` instead of `subagent_type`, and `read` takes `path`
instead of `filePath`; check both spellings. In `setup`, hooks register on the
context (`context.tool.hook("execute.before", fn)`,
`context.session.hook("context", fn)` for system lines as
`{ type: "text", text }`), a throw in `execute.before` still blocks the call,
and the returned function disposes the registrations. Both formats were
verified against 1.18.30 and 2.0.26 on 2026-10-09; `/plugins` is not a
command in either, so check a server plugin by its effect, not a listing.

`plugins/tui/` holds TUI plugins, which may also import `solid-js` and
`@opentui/solid`: OpenCode's runtime maps those specifiers to its own bundled
copies, so they still need no install. They are listed in `config/tui.json`,
not `config/opencode.json`, and `bin/opencode-tellico` points
`OPENCODE_TUI_CONFIG` at the installed copy, which OpenCode merges over the
user's own `tui.json` -- on OpenCode 1 only, since the vendored panel is
written against OpenCode 1's TUI API (`{ id, tui }`) and has no OpenCode 2
release. `subagent-watch.js` is vendored verbatim from
`opencode-subagent-watch` (MIT) so that it is pinned and needs no network at
startup: upgrade it by replacing everything below its header, never by
editing it in place. It lists child sessions in the sidebar, since background
workers otherwise scroll out of view while the lead keeps talking.

OpenCode 2 gets `plugins/tui-v2/subagents/tui.js` instead, our own small port
of the same panel: a row per subagent with its status, and a click opens that
subagent's session. OpenCode 2 loads TUI plugins from the `plugins` list of
its CLI config (`~/.config/opencode/cli.json`), never from `tui.json`, so the
launcher passes it in `OPENCODE_CLI_CONFIG_CONTENT`. That overlay *replaces*
arrays rather than merging them, so `tellico_cli_plugin_overlay` copies the
user's own list in first (reading cli.json as JSONC) and prints nothing when
it cannot, in which case the panel is skipped rather than the user's plugins
dropped. A TUI plugin there is a directory whose `tui.js` default-exports
`{ id, setup(context) }`; `context.ui.slot({ append: "sidebar.content",
render })` places it, `context.data.session` (`family`, `status`, `get`) is
reactive so no polling is needed, and `context.ui.router.navigate({ type:
"session", sessionID })` opens a session. Verified 2026-10-09 in a real 2.0.26
TUI under tmux: the row showed a running worker, and clicking it opened the
worker's session. OpenCode 2 hides the sidebar by default; `ctrl+x b` shows it.

`gateway/tellico_gateway.py` is standard library only. Adding a dependency to
it means a virtualenv on every gateway host, so do not. It never runs on the
cluster, which is ppc64le on RHEL 7.6, so normal x86 Python is fine there.

Never commit credentials. `api-key` and `client.env` are gitignored; keep it
that way and never inline a key into JSON or a unit file.

## Editing config or prompts does nothing until you install

`config/opencode.json`, `pi/`, `crush/`, `prompts/*.md` and the `plugins/`
files are templates.
Both harnesses read the installed copies under `~/.config/tellico-qwen/`.
`config/opencode.json`, `config/tui.json` and `pi/models.json` are substituted
rather than copied, by `tellico_render_config`: `__TELLICO_BASE_URL_0__` and
`__TELLICO_BASE_URL_1__` become loopback tunnel ports or gateway node paths
depending on the mode, `__TELLICO_PLUGIN_DIR__` becomes the installed plugin
directory, and `__TELLICO_CONFIG_DIR__` becomes the configuration directory, so
never hardcode any of them back in. Whatever the fingerprint in
`tellico_config_fingerprint` puts back has to match, or `./doctor.sh` reports a
rendered file as drifted on every device. A change to this repo has no effect
until `./install.sh --no-start` copies it across, and both harnesses load their
configuration and extensions once at startup, so the user must then restart
their session. Say so explicitly when handing back a change to any of them.

`./doctor.sh` now detects this: `tellico_check_drift` compares every installed
copy with the checkout and its `installed` line says which ones are stale.

## The context coupling

Each server divides one pool across slots, so the per-request limit is
`QWEN38_CTX / QWEN38_SLOTS` on the cluster side. `limit.context` in
`config/opencode.json` must equal that number for both providers. If it is too
high, OpenCode builds a context the server rejects instead of compacting in
time; if too low, context is wasted. The model display names encode it too
(`128k`), so they drift with it. Today that is 262144 / 2 = 131072.

`limit.input` must be set to the same number, and carries `compaction.reserved`
with it. OpenCode decides when to compact in `vn()`:
`limit.input ? limit.input - reserved : context - min(limit.output, 32000)`.
With `limit.input` absent, `reserved` is read and then thrown away, and the
buffer is silently whatever `limit.output` happens to be -- so lowering
`limit.output` to bound a runaway would *raise* the compaction threshold and
start producing requests the server hard-rejects. With it set, the buffer is
`reserved` and nothing else: 40,000 today, which is the 32,000-token output
allowance plus slack for one more turn's tool results. Compaction must fire
early enough that its own request fits as well, because it renders the whole
head of the conversation -- reasoning blocks included, which is most of it --
into a single prompt.

Those cluster-side values live in `/data/gclab/qwen38/service.env`, outside both
repos. Changing the model, slot count, micro-batch or speculative decoding there
changes what fits, which changes this repo. The model id (`qwen3.8-27b-gsq-iq3s`) is
the cluster's `QWEN38_MODEL_ALIAS` and appears in `config/opencode.json`,
`bin/opencode-tellico`, `lib/checks.sh` and the gateway defaults; a model swap
touches all of them.

## Architecture boundaries

- `bin/tellico-qwen-tunnel` owns the SSH control socket and port forwards.
  Everything else goes through it; do not open ad-hoc tunnels.
- Codex was evaluated and rejected, so do not reach for it again: 0.153.4
  exposes no spawn, task or agent tool to the model even with
  `multi_agent_v2` enabled, and `enable_fanout` is removed. It parallelises
  shell commands inside one conversation, which costs no model slots, so a
  Codex session is one node and cannot use the two workers this setup exists
  for -- strictly less parallel than OpenCode here. The gateway keeps
  `/v1/responses` and `fold_system_items` because they are generic
  Responses-API support, not Codex-specific.
- A tool-call batch is a barrier: one assistant message with N tool calls needs
  all N results before the model can speak again, so the lead cannot act on the
  first worker's report while the second still runs. That shapes how
  `prompts/orchestrate.md` tells the lead to size a pair. Do not "fix" it by
  adding more workers. On the 27B two requests on one node ran at half speed
  each for no aggregate gain; the GSQ IQ3_S build with DFlash2 does gain in
  aggregate (72-86 tok/s alone on code, 52-70 each at two) but every extra
  request still slows the others, and the four slots are shared by up to three
  users.
  The fastest capacity is still a node with *nothing* running on it.
- The barrier is not absolute, and `bin/opencode-tellico` now removes it. The
  older claim here that OpenCode has no background task primitive was wrong:
  the 1.18.30 binary defines the task tool twice, once as `{description,
  prompt, subagent_type, task_id, command}` and once with `background` added
  -- "Run the agent in the background. You will be notified when it completes.
  DO NOT sleep, poll, or proactively check on its progress" -- and
  `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is what selects the second. So
  the launcher exports it, and `prompts/orchestrate.md` tells the lead to pass
  `background: true` and to refill the server that just came free. Without
  both halves nothing changes: the flag only offers the parameter, and the
  model has to ask for it.
- `task_id` is the other half of that schema and is not used yet: it resumes a
  prior subagent session instead of creating a fresh one, which would keep a
  worker's prompt cache warm across dispatches. Worth trying once background
  dispatch has settled.
- Background dispatch is off for `opencode run` and the launcher enforces that,
  because a one-shot run loses every background result. Measured with the same
  two-worker dispatch both ways: in the foreground the lead collects both
  reports and answers; in the background both workers finish, the lead regains
  control immediately -- which is the feature working -- and then ends its turn
  saying "Waiting for their reports", having lost both. A background result
  arrives as a notification and needs a later turn to land in, and a run has
  none. This is the shape of upstream issue 48826.
- So the interactive path is the only one that can deliver a result, and it is
  live but not yet proven end to end: a TUI session cannot be driven from a
  script, so nobody has watched a notification actually land. If a worker's
  report ever goes missing, `TELLICO_BACKGROUND_SUBAGENTS=0` is the first
  thing to try, and the symptom to look for is a lead that announces it is
  waiting for reports and then stops.
- The capacity argument above is untouched either way: the slot count is
  what it is, and a third worker still costs the others speed. What changed
  is only that a finished worker's slot can now be refilled.
- Background dispatch moved the lead's own slot from free to occupied, and that
  changed which worker the lead should reach for first. The lead generates on
  its own node, and it used to park while workers ran, so a worker on that same
  node cost nothing. Now the lead keeps working, so `tellico-worker-N` competes
  with `orchestrate-tellico-N` for one server. Observed live: node 1 at 2 of 2
  requests with the lead and `tellico-worker-1` halving each other, node 0 at 0
  of 2 and a whole GPU idle. `prompts/orchestrate.md` therefore sends the first
  unit of a round to the far node, and `plugins/dispatch-balance/` nudges
  when a task goes to the lead's own node while the far node has nothing in
  flight -- only under background dispatch, since in the foreground the lead
  parks and a lone worker there is fine. It needs to know where the lead runs
  and no plugin hook reports that, so `bin/opencode-tellico` exports the
  resolved `TELLICO_LEAD_NODE`; with the variable absent the nudge stays
  silent rather than guessing.
- Sizing a pair by cost was advice for the barrier, so it is gone from
  `prompts/orchestrate.md` and `plugins/dispatch-balance/` suppresses its
  imbalance nudge when the flag is set, keeping the same-node and
  serial-dispatch nudges, which hold either way. The plugin reads the variable
  from its own environment, which works because the launcher exports it into
  the process OpenCode runs in.
- Thinking level is a model *variant*, not a model or an agent. The four
  variants in `config/opencode.json` (`off`, `low`, `medium`, `xhigh`) are the
  only values the Qwen3.8 template accepts -- it raises `Unexpected reasoning
  effort` on anything else, which is how `high` was ruled out. (The
  Qwen3.6-35B-A3B served briefly on 2026-10-09 read only `enable_thinking`,
  so the levels collapsed to on/off there; they are graded again.) Each carries
  `chat_template_kwargs`, the channel proven to reach the template; a
  top-level `reasoning_effort` works against llama.cpp directly but is not
  what OpenCode forwards. The lead and both workers declare `variant: medium`
  in `config/opencode.json`, so that is the default without relying on the
  cluster's `--reasoning-effort medium` server flag; the three overhead agents
  instead pin `enable_thinking: false` (see `plugins/` below). Narrower scopes
  override it in order: `--think` sets the variant per agent at runtime, the
  `/think-*` commands set it per request, and OpenCode's own `variant.cycle`
  (`ctrl+t`) and `variant.list` (bound to `<leader>t` in `config/tui.json`)
  change the session's -- which is the lead's only, because a worker's variant
  comes from its agent config at dispatch. `config/tui.json` is the keybind
  channel: `keybinds` is a TUI-config key, and `opencode.json` has no such
  key at all.
- `bin/opencode-tellico` derives the default lead node from `$USER@$(uname -n)`
  so concurrent users spread across both servers instead of all leading on
  node 0. It must stay *stable* per device: the point is prompt-cache affinity,
  which a random choice each session would destroy. An explicit `0`/`1` and
  `TELLICO_LEAD_NODE` still win.
- `bin/opencode-tellico` selects the lead node and injects runtime config via
  `OPENCODE_CONFIG_CONTENT`. OpenCode's interactive command rejects `--model`,
  so the model and lead agent must travel through that env var.
- `lib/checks.sh` holds shared validation used by both `install.sh` and
  `doctor.sh`. Add checks there, not in one caller. `tellico_base_url` and
  `tellico_render_config` live there for the same reason: they are the only
  places that know which placeholders `config/opencode.json` has, and
  `install.sh` renders with them while `tellico_check_drift` compares against
  them. A new placeholder goes in `tellico_render_config`, never in a caller's
  own `sed`.
- `tellico_check_drift` compares the installed copies with this checkout and is
  what makes the install gap above visible instead of merely documented. It
  compares `opencode.json` through `tellico_config_fingerprint`, which puts the
  per-device substitutions back, so drift means "no longer this repository's
  config" and not "installed for a different mode or port". Whether the
  endpoints are the right ones is `tellico_check_config`'s job and the gateway
  probe's.
- `plugins/` enforces what the prompts can only ask for, and exists only for
  things config cannot express. `secret-guard` blocks reads of the API key,
  `client.env` and SSH private keys: OpenCode's permission schema gates
  `edit`, `bash`, `webfetch`, `doom_loop` and `external_directory` but has no
  pattern gate for `read` at all, and both workers run `"*": "allow"`, so
  without it a credential can reach a worker report and from there the lead's
  context and `.agent/PLANS.md`. `dispatch-balance` counts task overlap and
  nudges once per session when the lead serialises, puts both halves of a pair
  on one node, or pairs a long task with a short one -- the three ways to idle
  a server, none of which the lead can see for itself. `compaction-guard`
  forces `enable_thinking: false` on the three native overhead agents
  (compaction, summary, title): `agent.compaction.options` in the config says
  the same thing, but a model variant is merged *after* agent options and
  compaction inherits the variant of the user message that triggered it, so
  under `--think xhigh` the config alone loses and `chat.params` -- the last
  hook before the request leaves, and the only one carrying the agent name --
  is the only place that wins; it is the one plugin here with no OpenCode 2
  half, because that release has no verified counterpart to `chat.params`, so
  there the config entry is the whole of it. All three are allowlist-first
  like every check here: a form they cannot recognise is allowed through rather
  than guessed at. They are registered through `__TELLICO_PLUGIN_DIR__` in
  `config/opencode.json`, substituted to an absolute path at install time
  because a relative path would resolve against whatever OpenCode considers the
  config root. A plugin the config names but the install did not copy is
  silently skipped by OpenCode, which is why `tellico_check_config` fails on a
  missing one rather than warning.
- Agents: two primaries per node plus two node-pinned workers.
  `orchestrate-tellico-0|1` delegates, and `build-tellico-0|1` is the solo
  alternative that does the work itself and cannot dispatch at all
  (`--solo` / `TELLICO_SOLO=1` only chooses which one a session opens on;
  `tab` switches between them). Their permissions are deliberately opposite
  where it counts: the lead has no `bash` beyond read-only `git` because its
  job is to delegate commands, and `build-tellico` has full `bash` and `edit`
  with `task` denied. `build-tellico` does not say `"*": "allow"` the way the
  workers do -- it lists what it needs, so OpenCode's own `external_directory:
  ask` survives for an agent a user is driving directly. A prompt file is
  always-on context for its agent, so every line added to
  `prompts/orchestrate.md` or `prompts/build.md` costs tokens on every turn of
  that agent. Keep them tight, and keep what is genuinely shared --
  `.agent/PLANS.md` as the thing that survives compaction, the credential
  rule, verify-before-you-carry-forward -- saying the same thing in both.
- `pi/` is the whole pi harness: `models.json`, `settings.json`,
  `APPEND_SYSTEM.md` and `extensions/`, installed to
  `~/.config/tellico-qwen/pi` with `PI_CODING_AGENT_DIR` pointing at it. Pi
  reads one directory for all of that, so overriding that one variable is the
  entire isolation mechanism -- there is no per-file override and no merge with
  `~/.pi/agent`, which is why the user's own extensions and skills are not
  loaded in a Tellico session and why uninstalling cannot damage them. Sessions
  are deliberately moved out with `PI_CODING_AGENT_SESSION_DIR`: pi defaults
  them to `<agent-dir>/sessions`, and that would make `uninstall.sh` choose
  between leaving files behind and deleting transcripts.
- Pi is a single-agent harness -- no subagents, no plan mode -- so `pi-tellico`
  is the counterpart of `opencode-tellico --solo` and there is nothing for
  `prompts/orchestrate.md` or `plugins/dispatch-balance/` to do there. Do not
  try to rebuild the lead/worker split in it.
- `pi/APPEND_SYSTEM.md`, not `SYSTEM.md`: pi's `SYSTEM.md` *replaces* its own
  system prompt, which would throw away everything it says about its own tools.
  The addendum carries only what pi cannot know -- the cluster, the context
  economy, `.agent/PLANS.md`, verification and the credential rule.
- The thinking channel is `compat.thinkingFormat: "chat-template"` plus
  `chatTemplateKwargs`, which puts `enable_thinking` and `reasoning_effort`
  inside `chat_template_kwargs`, the channel this repository already proved
  reaches the Qwen template. Auto-detection would have chosen `"openai"` (a
  top-level `reasoning_effort`) instead. Two other auto-detected defaults are
  wrong for llama.cpp and are set explicitly: `supportsDeveloperRole` would be
  true and send role `developer` where the template wants `system`, and
  `maxTokensField` would be `max_completion_tokens` rather than `max_tokens`.
  Pi has seven thinking levels and the template accepts three, so
  `thinkingLevelMap` maps `minimal`, `high` and `max` to `null`: that marks
  them unsupported, removes them from `/thinking`, and makes a request for
  `high` clamp to `xhigh` instead of reaching the template and raising
  `Unexpected reasoning effort`.
- `compaction.reserveTokens` is 40960 because in pi it is two things at once:
  compaction fires above `contextWindow - reserveTokens`, and the summary's own
  output is capped at `min(0.8 * reserveTokens, maxTokens)`. 40960 gives the
  summary the model's whole 32,768-token allowance and starts compacting at
  90,112, which is the same headroom `compaction.reserved` buys under OpenCode.
  Lowering it tightens both at once, and a truncated summary is the failure
  this repository already paid for once.
- `cacheWarming` is `"off"`. Four slots serve every user of this cluster, so a
  warming request is a slot taken from someone's real work; and it could not
  fire anyway, because warming needs an estimated $0.05 of avoided cache-miss
  cost and this model's declared cost is zero.
- `pi/extensions/secret-guard/` matters more than its OpenCode counterpart, not
  less. Pi has no permission system -- its own security guide says it "does not
  ask for approval before every tool call" -- so nothing else stands between
  the model and the API key, and `models.json` names the key's path in a
  `!cat` command the model can read. Pi's `tool_call` event blocks a call
  outright and a throwing handler blocks it too, so unlike the OpenCode plugin
  this one fails closed.
- `crush/` is the Crush harness, and it is the one piece here that writes
  outside `~/.config/tellico-qwen`. Crush merges `./.crushrc`, `./crushrc` and
  `$XDG_CONFIG_HOME/crush/crushrc` and has no config flag or environment
  variable, so there is nothing to point at a private directory the way
  `OPENCODE_CONFIG` and `PI_CODING_AGENT_DIR` are pointed. Relocating the
  search with `XDG_CONFIG_HOME` is the obvious trick and is wrong: the variable
  is inherited by every command the model runs through the `bash` tool, which
  would send the agent's own `git`, `nix` and `gh` to a configuration directory
  that only has Crush in it. So `install.sh` appends one marked line to the
  user's own `crushrc` and `uninstall.sh` removes exactly that line and the
  comment above it. Because that file is the user's, the fragment sets nothing
  that is not about Tellico -- no `option default-providers`, no `permissions
  allow`. `doctor.sh` has a `crushrc` check because this is the only harness
  that can be half-installed.
- `crushrc` is Bash, which is the only reason `crush-tellico` can work: Crush
  has no flag that selects a model for an interactive session, so the launcher
  exports `TELLICO_LEAD_NODE` and `TELLICO_THINK` and the fragment reads them.
  That depends on Crush loading its configuration once per invocation, which
  v0.98.1 does -- a plain `crush` starts no background server, verified by
  watching for its socket. If a future version delegates to the shared server
  the way OpenCode 2 does, a second session's `--think` would be silently
  ignored and the levels would have to become providers instead.
- Four Crush providers, not two. `extra_body` is per provider, so the thinking
  level cannot vary per model on one provider; `tellico-N` carries the
  session's level and `tellico-N-quiet` has thinking off and holds the
  *small model* slot, which Crush uses for titles and auto-summarize. That is
  the same rule `plugins/compaction-guard/` enforces under OpenCode, expressed
  declaratively instead.
- The Crush models are deliberately not `--can-reason`. Crush's own
  `--reasoning-effort` accepts `low`, `medium` and `high`; the Qwen3.8 template
  accepts `low`, `medium` and `xhigh` and raises `Unexpected reasoning effort`
  on `high`. Marking the model as reasoning-capable would put a value in the UI
  that the server rejects, so the level travels in `extra_body` and Crush adds
  nothing of its own.
- `option request-timeout 3600`. Crush's default is 60 seconds of inactivity,
  and prompt reading counts as inactivity: at the measured 430-650 tok/s a cold
  110k-token prompt waits about four minutes for its first token, so every deep
  session would die on the default. It is the same thing `headerTimeout` and
  `chunkTimeout` do in `config/opencode.json`.
- `crush/hooks/secret-guard.sh` is POSIX sh because Crush exports
  `CRUSH_TOOL_NAME`, `CRUSH_TOOL_INPUT_FILE_PATH` and
  `CRUSH_TOOL_INPUT_COMMAND`, so the guard needs no JSON parsing and no
  toolchain. Exit 2 blocks the call with stderr as the reason the model sees;
  any other non-zero exit is a non-blocking warning, so a bug lets the call
  through rather than wedging the session -- the same under-enforcing failure
  mode as the other two guards. Keying on the normalised file path rather than
  each tool's own argument means a new file tool is covered the day Crush adds
  one. Crush documents that `PreToolUse` fires only on the top-level agent's
  tool calls, which covers everything while Crush has no subagents; when PR
  3098 lands, this stops covering them.
- `config/gateway-url` is the single source of the built-in gateway URL, read
  by both `install.sh` and `doctor.sh` so a user supplies only a key. It is a
  plain file rather than a value in `lib/checks.sh` because both scripts need
  it while parsing arguments, before they source that library. Never duplicate
  the URL into a script.
- The client installs in one of two modes, recorded as `TELLICO_MODE` in
  `client.env`. `tunnel` forwards the cluster endpoints over SSH; `gateway`
  points the same two providers at the gateway's `/v1/node0` and `/v1/node1`
  paths and needs no cluster account. The session is identical either way, so
  a change to agents, prompts or context must hold for both. `install.sh`,
  `doctor.sh` and `tellico-qwen-tunnel` all branch on it, and in gateway mode
  `tellico-qwen-tunnel start` only probes the gateway -- which is why
  `opencode-tellico` needs no mode logic of its own.
- `gateway/tellico_monitor.py` is read-only and reports from three sources:
  each server's `/metrics` and `/slots` (ground truth, includes tunnel users),
  the gateway's runtime state file (exact per-user concurrency), and the
  gateway's journal (history). Per-user data is deliberately not on an HTTP
  route: the gateway's port is published to the internet. It must degrade to
  whatever is available rather than require the gateway.
- `gateway/` is the second, independent way in: an OpenAI-compatible endpoint
  with per-user keys, for users who have no cluster account. It sits *on top
  of* the client install on one host, reading `~/.config/tellico-qwen/api-key`
  and the tunnel's loopback ports. It must never start, stop or restart the
  tunnel — `tellico-qwen-tunnel` still owns that, and a live session depends
  on it.
- The gateway's job is admission control, not throughput. The cluster has
  four slots (2 per node), so `TELLICO_GATEWAY_MAX_INFLIGHT` defaults to 3
  to leave one for a direct `opencode-tellico` lead. Within that, leads go
  first: a request carrying `X-Tellico-Role: worker` waits while any lead is
  queued, and workers together never hold every slot. The client sets that
  header through the `tellico-0-worker` / `tellico-1-worker` providers, which
  only the worker agents use; anything unlabelled counts as a lead. This
  ordering exists only in the gateway -- tunnel-mode sessions reach
  llama-server directly, which serves strictly first come, first served. Raising it does not add
  capacity; it only moves the queue. `TELLICO_GATEWAY_MODEL_ALIASES` keeps
  old model ids (`qwen3.8-27b`) routing to the current model so gateway users
  configured before a swap do not start getting 404s.
- `TELLICO_GATEWAY_CONTEXT` is derived from `config/opencode.json` at install
  time, so it is bound by the same context coupling described above. A change
  to the cluster's per-slot context means rerunning the gateway installer too.
