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

`gateway/tellico_gateway.py` is standard library only. Adding a dependency to
it means a virtualenv on every gateway host, so do not. It never runs on the
cluster, which is ppc64le on RHEL 7.6, so normal x86 Python is fine there.

Never commit credentials. `api-key` and `client.env` are gitignored; keep it
that way and never inline a key into JSON or a unit file.

## Editing config or prompts does nothing until you install

`config/opencode.json`, `prompts/*.md` and the `plugins/` files are templates.
OpenCode reads the installed copies under `~/.config/tellico-qwen/`.
`config/opencode.json` is substituted rather than copied:
`__TELLICO_BASE_URL_0__` and `__TELLICO_BASE_URL_1__` become loopback tunnel
ports or gateway node paths depending on the mode, and `__TELLICO_PLUGIN_DIR__`
becomes the installed plugin directory, so never hardcode either back into it. A
change to this repo has no effect until `./install.sh --no-start` copies it
across, and OpenCode loads config and plugins once at startup, so the user must
then restart their session. Say so explicitly when handing back a change to any
of them.

`./doctor.sh` now detects this: `tellico_check_drift` compares every installed
copy with the checkout and its `installed` line says which ones are stale.

## The context coupling

Each server divides one pool across slots, so the per-request limit is
`QWEN38_CTX / QWEN38_SLOTS` on the cluster side. `limit.context` in
`config/opencode.json` must equal that number for both providers. If it is too
high, OpenCode builds a context the server rejects instead of compacting in
time; if too low, context is wasted. The model display names encode it too
(`128k`), so they drift with it. Today that is 262144 / 2 = 131072.

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
  what OpenCode forwards. `--think` sets the variant per agent at runtime; the
  `/think-*` commands set it per request.
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
  a server, none of which the lead can see for itself. Both are allowlist-first
  like every check here: a form they cannot recognise is allowed through rather
  than guessed at. They are registered through `__TELLICO_PLUGIN_DIR__` in
  `config/opencode.json`, substituted to an absolute path at install time
  because a relative path would resolve against whatever OpenCode considers the
  config root. A plugin the config names but the install did not copy is
  silently skipped by OpenCode, which is why `tellico_check_config` fails on a
  missing one rather than warning.
- Agents: one lead (`orchestrate-tellico-0|1`) plus two node-pinned workers.
  `prompts/orchestrate.md` is always-on context for the lead, so every line
  added costs tokens on every turn. Keep it tight.
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
