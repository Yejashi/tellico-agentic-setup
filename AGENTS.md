# AGENTS.md

Client-side setup that points OpenCode at two self-hosted Qwen3.8-27B servers on
the Tellico cluster. This repo installs files onto the client device; it does not
run the servers.

## Commands

- `./doctor.sh` — check everything the client needs, in dependency order. Run
  this first when something is broken.
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

`gateway/tellico_gateway.py` is the one exception, and it is standard library
only. Adding a dependency to it means a virtualenv on every gateway host, so
do not. It never runs on the cluster, which is ppc64le on RHEL 7.6, so normal
x86 Python is fine there.

Never commit credentials. `api-key` and `client.env` are gitignored; keep it
that way and never inline a key into JSON or a unit file.

## Editing config or prompts does nothing until you install

`config/opencode.json` and `prompts/*.md` are templates. OpenCode reads the
installed copies under `~/.config/tellico-qwen/`. `config/opencode.json` is
substituted rather than copied: `__TELLICO_BASE_URL_0__` and
`__TELLICO_BASE_URL_1__` become loopback tunnel ports or gateway node paths
depending on the mode, so never hardcode a URL back into it. A change to this repo has no
effect until `./install.sh --no-start` copies it across, and OpenCode loads
config once at startup, so the user must then restart their session. Say so
explicitly when handing back a config change.

## The context coupling

Each server divides one pool across slots, so the per-request limit is
`QWEN38_CTX / QWEN38_SLOTS` on the cluster side. `limit.context` in
`config/opencode.json` must equal that number for both providers. If it is too
high, OpenCode builds a context the server rejects instead of compacting in
time; if too low, context is wasted. The model display names encode it too
(`96k`), so they drift with it.

Those cluster-side values live in `/data/gclab/qwen38/service.env`, outside both
repos. Changing speculative decoding there changes the context, which changes
this repo.

## Architecture boundaries

- `bin/tellico-qwen-tunnel` owns the SSH control socket and port forwards.
  Everything else goes through it; do not open ad-hoc tunnels.
- Codex cannot delegate: 0.153.4 exposes no spawn, task or agent tool to the
  model, even with `multi_agent_v2` enabled, and `enable_fanout` is removed. It
  parallelises shell commands inside one conversation, which costs no model
  slots. So a Codex session is one node, and `codex-tellico` pins one rather
  than using the gateway's pooled path. Do not add worker agents to it.
- `bin/codex-tellico` runs Codex against the same servers. Four constraints
  make it work and none are obvious: `wire_api` must be `"responses"` (the only
  value Codex 0.153 accepts, and llama.cpp does implement that endpoint);
  `model_reasoning_effort` must be overridden because Codex passes it to the
  chat template, which rejects its usual `high`; Codex must go through the
  gateway, because it sends `instructions` plus a `developer` message and the
  template refuses the second system message llama.cpp makes of that; and the
  gateway needs a per-user key, which the cluster key is not. `fold_system_items`
  in the gateway is what makes the third one work -- do not remove it.
- A tool-call batch is a barrier: one assistant message with N tool calls needs
  all N results before the model can speak again, so the lead cannot act on the
  first worker's report while the second still runs. OpenCode has no async or
  background task primitive (`experimental.batch_tool` is unrelated), so this
  is not fixable in config -- only by how `prompts/orchestrate.md` tells the
  lead to size a pair. Do not "fix" it by adding more workers: two requests on
  one node run at half speed each for no aggregate gain, so a third worker buys
  nothing. The free capacity is a node with *nothing* running on it.
- Thinking level is a model *variant*, not a model or an agent. The four
  variants in `config/opencode.json` (`off`, `low`, `medium`, `xhigh`) are the
  only values the chat template accepts -- it raises `Unexpected reasoning
  effort` on anything else, which is how `high` was ruled out. Each carries
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
  `doctor.sh`. Add checks there, not in one caller.
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
- The gateway's job is admission control, not throughput. The cluster serves
  about four concurrent requests, so `TELLICO_GATEWAY_MAX_INFLIGHT` defaults to
  3 to leave one slot for a direct `opencode-tellico` session. Raising it does
  not add capacity; it only moves the queue.
- `TELLICO_GATEWAY_CONTEXT` is derived from `config/opencode.json` at install
  time, so it is bound by the same context coupling described above. A change
  to the cluster's per-slot context means rerunning the gateway installer too.
