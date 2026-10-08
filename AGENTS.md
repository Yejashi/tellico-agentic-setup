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
installed copies under `~/.config/tellico-qwen/`. A change to this repo has no
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
- `bin/opencode-tellico` selects the lead node and injects runtime config via
  `OPENCODE_CONFIG_CONTENT`. OpenCode's interactive command rejects `--model`,
  so the model and lead agent must travel through that env var.
- `lib/checks.sh` holds shared validation used by both `install.sh` and
  `doctor.sh`. Add checks there, not in one caller.
- Agents: one lead (`orchestrate-tellico-0|1`) plus two node-pinned workers.
  `prompts/orchestrate.md` is always-on context for the lead, so every line
  added costs tokens on every turn. Keep it tight.
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
