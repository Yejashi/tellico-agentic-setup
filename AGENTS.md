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
- `sh tests/run.sh` — offline regression suite (Node 22+ and Python 3); GitHub
  Actions runs it too. No live services or credentials required.
- `sh -n <script>` — POSIX shell syntax check.
- `python3 -m json.tool config/opencode.json` — validate the config before
  installing it.
- `opencode debug config` — show the config OpenCode actually resolved.
- `tellico-qwen-tunnel status` / `doctor` — check the live tunnel.
- `gateway/install-gateway.sh` — install the API gateway on this host. Safe
  while a session is live: it never restarts the tunnel.
- `tellico-gateway status` / `doctor` / `logs` — check the live gateway.
- `python3 -m py_compile gateway/tellico_gateway.py` — syntax check the gateway.
- `remote/install-remote.sh` — install the phone-facing OpenCode server on this
  host. Safe while a session is live: it never restarts the tunnel or the
  gateway, and a rerun keeps the existing password so a paired phone and the
  proxy's hash stay valid.
- `tellico-remote status` / `doctor` / `logs` — check the live remote server.
  Both `status` and `doctor` probe the published URL and say so loudly if it
  answers without a password.
- `relay/install-relay.sh` — install the phone relay beside the gateway; safe
  while sessions are live (no gateway, tunnel or proxy restart).
  `tellico-relay status` / `logs` check it. `./install.sh --no-start
  --remote-control` turns publishing on for a device.
- `dashboard/install-dashboard.sh` — install the usage dashboard beside the
  gateway; safe while sessions are live. `tellico-dashboard status` /
  `report [1h|6h|24h|7d|30d]` / `logs`.
- `tellico-remote caddy` — the reverse-proxy snippet for this host, with its
  bcrypt hash filled in. Never commit a real hash.

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
`bin/opencode-tellico`, `lib/checks.sh`, `config/magic-context.jsonc` and the
gateway defaults; a model swap touches all of them.

## Architecture boundaries

- A session belongs to the OpenCode process running it. Another server on the
  same storage lists it and sees its text as it is flushed, in coarse blocks,
  but receives no events for it and reports it inactive (measured on 2.0.26,
  two servers, 2026-10-13). So live viewing and steering only work through the
  server that started the session: that is why `remote/` runs on the always-on
  host rather than mirroring a laptop's sessions, and why the VS Code
  extension's per-window private server is invisible to the phone.
- The phone relay (`relay/`, `plugins/remote-control`) is how sessions on
  *any* machine reach a phone, because a plugin runs inside the process that
  owns them. In 2.0.26 the v2 plugin context gives `event.subscribe({ signal })`
  -- an async iterable, not a callback -- plus `session.get`,
  `session.context` (the full history), `session.prompt({sessionID, text})`
  and `session.interrupt({sessionID})`. Every location's subscription carries
  every location's events, so de-duplicate by event id, and some events
  (`session.execution.succeeded`) carry no location. A headless server
  auto-rejects permission asks, so the phone cannot answer them; Tellico's
  agents allow every tool anyway. All event-name knowledge lives in
  `plugins/remote-control/protocol.js`; recheck it after an OpenCode upgrade
  against `tests/fixtures/opencode2-events.jsonl`. The relay and the phone
  share an op vocabulary and are both tested against
  `tests/fixtures/relay-ops.json`, so keep them in step.
- The relay can ask a plugin for exactly a prompt or an interrupt, for a
  session that plugin itself runs. Do not widen that: the gateway key becomes
  a way to drive the user's agents once remote control is on.
- `remote/` adds no client code. The web app, its v2 API and its pairing
  (`POST /api/pair` mints a single-use code for five minutes;
  `/auth/connect/:code` returns a 30-day HttpOnly cookie) are OpenCode's own.
  The app is a PWA rooted at `/` -- manifest scope, start URL and cookie path
  -- so it cannot be served under a path prefix. `/v1/*` and `/health` belong
  to the gateway and must keep their own proxy route above the catch-all.
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
- The default engineer does ordinary reads, edits, checks and authorized Git
  itself; delegate substantial independent units only when it helps finish
  correctly. Keep exact write scopes and one shared build/Git owner. Idle
  workers are acceptable. Optimize verified completion time, not occupied slots.
- Dispatch is foreground by default (since 2026-10-14): a tool-call batch
  blocks the lead until every worker in it has reported. Background dispatch
  (`TELLICO_BACKGROUND_SUBAGENTS=1`, interactive only) permits overlap, but
  in practice the leads mishandled it -- reports still owed, notifications
  arriving mid-turn, the shared status file racing commits -- and that
  bookkeeping is what a lead was dithering over when it looped. Foreground
  also frees the lead's slot while workers run. Do not turn background back
  on by default without evidence the model now copes. The launcher explicitly
  sets the upstream flag true/false, including false for `opencode run`, so
  inherited environment cannot override the chosen mode. The plugin adds
  mode-specific instructions. Background notification delivery itself works:
  verified on 2.0.26 on 2026-10-13 over `opencode-tellico serve`, the
  worker's completion arrived as a synthetic inbox item and the lead resumed.
- The lead and same-numbered worker share a node. Prefer the far worker while
  the lead is generating, but other users may occupy either server. Current
  measurements show aggregate gains for two requests on the 2026-10-11 engine;
  do not claim all sharing halves speed or that an untracked node is idle.
- Consecutive work in one subsystem may resume a worker using the returned
  session ID if supported (`task_id` on OpenCode 1). Use a fresh session for
  unrelated work or stale/crowded context; continuity is not a cache guarantee.
- `plugins/dispatch-balance` no longer nudges serial dispatch or unequal task
  sizes. Only known overlapping foreground calls to the same worker receive
  one scope/placement nudge. Background/unknown calls are excluded because
  execute-after may be dispatch return rather than worker completion. Optional
  `TELLICO_AGENT_TRACE` writes metadata-only tool/dispatch timing to an absolute
  JSONL path; no prompts, arguments or outputs. It is not model timing, real
  node occupancy, or proof of task success. Trace failures never fail work.
- Web search is OpenCode's own `websearch` tool, not an MCP server: an MCP
  server's tool schemas cost tokens on every turn of every agent, and its
  extract tool duplicates `webfetch`. OpenCode 2 reads the provider from a
  `websearch` config key, which `bin/opencode-tellico` sets from
  `TELLICO_WEBSEARCH` (default `tavily`, keyless; `off` removes the tool).
  Leaving the key unset makes the first search ask the user, which a
  background worker waits on for a minute and then cancels. OpenCode 1 has
  only Exa and Parallel, enabled by `OPENCODE_ENABLE_EXA` /
  `OPENCODE_ENABLE_PARALLEL` rather than config; the launcher sets the key only
  on OpenCode 2 because OpenCode 1 was never shown to accept it. Results go
  through the `tool_output` cap like any tool: a Tavily search measured
  2,830 tokens raw and was truncated to 8 KiB. Both primaries and workers can
  search; use targeted results and delegate large independent investigations
  when useful. Verified on 2.0.26 on 2026-10-10 with a real
  `build-tellico-0` run (`provider: tavily`, no prompt); the OpenCode 1 path
  was read from the 1.18.30 binary, not run.
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
  **OpenCode 2 needs `extraBody`.** 2.0.26 turns a v1-style options or
  variant object into `settings`, which the openai-compatible route never
  sends; only an `extraBody` key becomes request JSON (`qE` in the binary,
  confirmed with a logging proxy on 2026-10-13). So every variant and the
  model's `options` carry `extraBody` beside the v1 keys: OpenCode 1 sends
  the keys, OpenCode 2 sends `extraBody`, and llama-server ignores whichever
  it does not use (tested). Three more things measured on 2.0.26 shape the
  rest: an agent's `variant` is not applied when a session opens, a session's
  variant is applied to every request in it -- title, summary and compaction
  included -- and a per-launch config can *add* a key to a model's
  `extraBody` but not replace one; nested objects merge key by key. Hence:
  the model-level `chat_template_kwargs` holds only `preserve_thinking`, never
  `enable_thinking` or `reasoning_effort` (the server default, medium,
  applies), `--think` adds those per launch on OpenCode 2, a session variant (`ctrl+t`, `/think-*`,
  the VS Code picker) still wins over that, and the overhead agents use a
  `qwen3.8-27b-gsq-iq3s-quiet` twin with thinking hard-off and no variants
  (OpenCode 2 only; OpenCode 1 keeps `compaction-guard`). Each fact has a
  test in `tests/launcher.test.mjs`. The server also defaults `--temp 0.6`
  (qwen38-cluster 03a9d46), so sampling holds for any client.
  **No-thinking replies stop at `</think>`.** With thinking off this model
  sometimes writes its answer, then a `</think>` it never opened, then the
  answer again -- 4 of ~70 replays of a captured OpenCode request on
  2026-10-13 -- and once leaked a raw tool call into the text. The template
  renders the empty think block correctly; this is the model. So the `off`
  variant, the quiet model and `--think off` send `stop: ["</think>"]` (0 of
  40 replays malformed with it), and the thinking variants send `stop: []`
  to clear a launch-level stop, because there `</think>` is the real end of
  reasoning. A rarer plain early stop mid-word (one glacier essay, 630
  tokens, finish `stop`, no client disconnect in the server log) is not
  explained by this and was not reproduced in ~110 direct replays.
- `bin/opencode-tellico` derives the default lead node from `$USER@$(uname -n)`
  so concurrent users spread across both servers instead of all leading on
  node 0. It must stay *stable* per device: the point is prompt-cache affinity,
  which a random choice each session would destroy. An explicit `0`/`1` and
  `TELLICO_LEAD_NODE` still win.
- `bin/opencode-tellico` selects the lead node and injects runtime config via
  `OPENCODE_CONFIG_CONTENT`. OpenCode's interactive command rejects `--model`,
  so the model and lead agent must travel through that env var.
- `opencode-tellico serve` runs OpenCode 2's headless API server with that
  same runtime config and no TUI; it is the whole interface of the separate
  `tellico-vscode` extension, which spawns it per window with a random
  `OPENCODE_PASSWORD` and port. Plain `opencode serve` is already private
  (only `--service` registers the shared one), so it gets no `--standalone`,
  which `serve` rejects. It follows the launcher's dispatch default
  (foreground), and background can be turned on there as in the TUI. Keep Tellico logic in
  the launcher, not in the extension, so the two cannot drift.
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
  context and `.agent/PLANS.md`. `dispatch-balance` supplies dispatch-mode
  guidance, detects duplicate foreground worker calls and traces metadata;
  it never requires work merely to occupy a server. `compaction-guard`
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
- **Thinking loops are bounded at the request.** Measured 2026-10-14: the
  Qwen template keeps *every* earlier turn's thinking by default
  (`preserve_thinking`; llama-server says so at startup) and OpenCode sends
  each step's `reasoning_content` back, so all past thinking -- a stopped
  15k-character loop included -- stayed in the prompt and the model copied
  it; loops grew more frequent through a session. Every request now sends
  `chat_template_kwargs.preserve_thinking: false` (earlier turns' thinking
  dropped; the current turn's tool steps keep theirs, checked with
  `/apply-template`) and the work model sends `reasoning_budget_tokens: 8192`
  with a `reasoning_budget_message`, after which the server ends the think
  and the model acts (10/10 forced endings still made the correct edit; p99
  of real steps is ~10k chars, the rest were loops). Field names are from the
  server source; `reasoning_budget` is silently ignored. Verified through a
  real 2.0.26 server for the plain launch, `--think`, session variants and
  the quiet model, and through the gateway. The server sets the same
  defaults (qwen38-cluster `d55b563`, live from job 16171): `serve-node`
  passes `--chat-template-kwargs '{"preserve_thinking": false}'`,
  `--reasoning-budget 8192` and the message, so pi, Crush and raw-API users
  are covered too; request kwargs merge over the server's key by key. Its
  startup warning that reasoning is preserved checks the `preserve_reasoning`
  key and is wrong here -- verify with `/apply-template`, not the log.
- `plugins/disk-guard` blocks a write-type tool call when the target's
  filesystem has less than 64 MiB (or twice the content) free, and says
  the disk is full. On a full disk OpenCode's write creates the file and then
  fails to fill it, reports only "Unable to write", and leaves a 0-byte file;
  on 2026-10-14 a lead read that as a broken tool, argued with itself and
  looped. A throw in `execute.before` blocks the call before the file
  exists (verified on 2.0.26, and `statfsSync` works in its runtime).
  Allowlist-first: an unmeasurable path is let through.
  `TELLICO_DISK_MIN_FREE` raises the floor, for tests only.
- `plugins/loop-guard` stops a reply that has fallen into a repetition loop.
  Such a step never ends by itself on this model: it re-emits one paragraph
  until the 32,768-token output cap, holding a shared slot for minutes. Over
  90 stored sessions (2026-10-14) 16 of 2,861 long parts looped, mostly in
  workers' reasoning, the worst a 483-character paragraph for 121,709
  characters. The detector (`detector.js`) fires when >= 95% of the 50-char
  shingles in the last 1,500 characters already appeared earlier in the part,
  twice running; on that history it fired on exactly those 16 and on nothing
  that was merely quoting. Index every earlier position: sampling them missed
  that 483 = 7 x 69 loop. Do not replace it with a sampler: DRY and presence
  penalties punish reproducing context, which the edit tool requires. On a
  loop it interrupts the step (which also drops the upstream request and
  frees the slot) and prompts the session to act; for a worker it prompts the
  *lead* instead, because the interrupt makes the lead's subagent call fail
  with only "Subagent cancelled" and the worker's later output would reach
  no one (verified on 2.0.26 with a looping stub). At most 3 notes per
  session per 30 minutes *without progress*: a successful tool call clears
  the count, because a lead stopped silently on its fourth loop sat idle
  until the user typed "continue". The same plugin nudges a lead that ends
  its turn on an announced step ("Now let me add the tests.") with no tool
  call, once until it next makes progress (`stall.js`: 6 of 2,432 stored
  turn endings, all real, none waiting on a worker -- those name what they
  wait for and are excluded; workers are never nudged, their text is their
  report). `TELLICO_LOOP_GUARD=0` turns both off.
- Agents: two primaries per node plus two node-pinned workers.
  `build-tellico-0|1`, the launcher's default, implements and verifies
  directly with delegation denied; `orchestrate-tellico-0|1`
  (`--orchestrate`, or `TELLICO_SOLO=0`) has the same direct tools and may
  also delegate. Both
  list tools explicitly rather than blanket allow, retaining OpenCode's
  external-directory behavior. Primaries default to 200 steps; `--steps`
  extends both, while workers remain bounded at 200. Repository-specific
  instructions can still restrict checks or Git to a worker. Do not override
  those by changing the client permission configuration alone.
  Always-on prompts cost context each turn: keep them concise, honor the
  repository's designated progress file before `.agent/PLANS.md`, and keep
  durable state compact. Use focused checks during development, then one
  required pass on the final tree; repeat after affected edits/failures, or
  when the repository requires it. Verify acceptance boundaries, not just
  that a command or worker returned successfully.
- Magic Context is on by default in `opencode-tellico` and `pi-tellico`;
  `--no-magic-context` (or `TELLICO_MAGIC_CONTEXT=0`) turns it off for
  OpenCode. The launcher names `@cortexkit/opencode-magic-context` at a
  pinned version in its runtime config, not in `config/opencode.json`, so
  that switch can leave it out: the package comes from npm, which OpenCode
  fetches itself, and the switch is how to start without the network. Name
  only that package there. A runtime `plugin` list is
  *appended* to the installed file's list, and a plugin named in both loads
  twice -- measured on 2.0.26 with probe plugins whose server hook wrote a
  marker. Its historian is a hidden child session that holds a cluster slot,
  so `config/magic-context.jsonc` routes it through a worker provider with
  `variant: off`; `compaction-guard` does not cover it because it keys on
  OpenCode's own agent names. The plugin reads only
  `$XDG_CONFIG_HOME/cortexkit/magic-context.jsonc`, so `install.sh` links
  that path to the installed copy and never overwrites a user's own file
  there; `doctor.sh` reports which is in use. With it on, OpenCode's
  compaction is off for the whole session, workers included, and
  `compaction.reserved` is inert. The per-request cost is about 1,400 tokens
  of guidance in the `full` preset (the installed config picks `light`) plus
  about 2,500 tokens of `ctx_*` tool schemas.
- Under pi it is `npm:@cortexkit/pi-magic-context` in `pi/settings.json`'s
  `packages`; pi installs it into `~/.config/tellico-qwen/pi/npm` on the
  next start, and the extension cancels pi's own compaction itself, so
  `compaction.reserveTokens` only matters when it is not loaded. Keep both
  packages at the same version: they share one SQLite database and
  mismatched versions block each other's migrations (a test enforces it).
  The pi historian is a child `pi --print` that inherits
  `PI_CODING_AGENT_DIR`, so `historian.pi` names `tellico-1`/`tellico-0`
  with `thinking_level: off` -- pi has no worker providers. Historian model
  settings are honoured only from the user-level config, never a project's
  `.cortexkit/`. Crush has no Magic Context port.
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
  is the counterpart of the default `build-tellico` session and there is nothing for
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
  and prompt reading counts as inactivity: at the ~1050-1500 tok/s prefill of
  the 2026-10-11 engine at `-b`/`-ub` 1024 (2026-10-13; 1300-1900 at 2048) a
  cold 110k-token prompt still waits 75-105 seconds for its first token (four
  minutes on the engine before it), so every deep
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
- `crush/hooks/fetch-guard.sh` exists because Crush checks for
  auto-summarize only between steps, from the previous step's usage, and
  nothing checks a request's size before it leaves. Three `fetch` calls with
  `format: "html"` in one batch took a session from 62k to 149k tokens in a
  single step; the server rejected it, and the summary request failed the same
  way because it carries the whole history, so the session was lost. The hook
  rewrites the first html fetch of a session to markdown through
  `updated_input` (a shallow merge, so no JSON parsing) and blocks any later
  one. It does nothing unless `TELLICO_LEAD_NODE` is set, because the fragment
  that registers it runs in every Crush session the user starts.
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
  `opencode-tellico` needs no mode logic of its own for the installed mode.
- `opencode-tellico --connection tunnel|gateway` (`TELLICO_CONNECTION`)
  runs one launch over either mode without a reinstall; the VS Code
  extension's SSH/gateway switch is exactly this. It leaves the installed
  config alone and adds per-launch `provider` entries for all four providers
  with only `baseURL` and `apiKey`; OpenCode merges them over the installed
  ones, keeping models, variants and the worker header (verified on 2.0.26).
  `tellico-qwen-tunnel` reads the same variable after `client.env`, so it
  tunnels or only probes to match. The modes use different keys, so
  `tellico_key_file` gives the installed mode `api-key` and the other
  `api-key.<mode>`: a tunnel never overwrites a gateway key or the reverse,
  and every existing install is unchanged. The three secret guards already
  match `api-key` with any suffix. `install.sh` records the built-in gateway
  URL in tunnel mode too, so a tunnel install can switch to the gateway; the
  gateway key itself is written by the extension (mode 600, atomically) or
  by hand. Pi and Crush still use only the installed mode.
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
  Streamed lead requests are paced through `SmoothStream` behind a
  `TELLICO_GATEWAY_SMOOTH_MS` buffer (1 s), because a prompt chunk on the
  same node stalls every other stream there; workers, `X-Tellico-Smooth: 0`
  and anything after the first tool-call delta pass straight through.
- The gateway logs each request with llama.cpp's own closing `timings`
  (tokens read, reused from cache and generated, prompt and generation ms,
  draft acceptance, finish reason, client gone), read from a 16 KiB tail of
  the stream, so streamed requests are metered too. New fields go *after*
  `out=`: `tellico_monitor` and the dashboard parse the leading ones.
- `dashboard/` keeps 30 days of node samples and gateway requests in SQLite
  on the gateway host, capped at 200 MB because that disk is ~20 GB. It has
  no access control and refuses any bind but loopback; it is reached over
  ssh and never published through Caddy.
- `TELLICO_GATEWAY_CONTEXT` is derived from `config/opencode.json` at install
  time, so it is bound by the same context coupling described above. A change
  to the cluster's per-slot context means rerunning the gateway installer too.
