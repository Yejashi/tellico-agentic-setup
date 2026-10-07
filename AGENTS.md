# AGENTS.md

Client-side setup that points OpenCode at the two self-hosted Qwen3.8 servers on
the Tellico cluster. One model per compute node, and the two nodes need not run
the same one. This repo installs files onto the client device; it does not run
the servers.

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

`shellcheck -s sh` is the intended linter and the scripts carry
`# shellcheck disable=` directives, but it is not installed here. Do not claim a
shellcheck result without running it.

## Hard constraints

Everything here is `#!/bin/sh`. Write POSIX shell, not bash: no arrays, no
`[[ ]]`, no `local`, no `${var,,}`. The cluster-side repo (`qwen38-cluster`) is
bash and its nodes run bash 4.2 — keep the two straight.

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
`config/opencode.json` must equal that number for the matching model. If it is
too high, OpenCode builds a context the server rejects instead of compacting in
time; if too low, context is wasted. The model display names encode it too
(`96k`, `128k`), so they drift with it.

The coupling is now per model, not per provider:

| Model id | Per-slot context | From |
|---|---:|---|
| `qwen3.8-27b` | 98,304 | `QWEN38_CTX` 196,608 / 2 slots |
| `qwen3.8-27b-pool` | 65,536 | `QWEN38_CTX` 196,608 / 3 slots |
| `qwen3.8-flash-next` | 131,072 | `QWEN38_CTX_FLASHNEXT` 262,144 / 2 slots |

All three ids are declared under both providers, because either node can serve
any of them. `qwen3.8-27b-pool` exists only because a re-slotted 27B has a
different per-slot figure from the default one and a single id cannot carry
both; it is the same weights and the same pool, divided three ways.

Those cluster-side values live in `/data/gclab/qwen38/service.env`, outside both
repos. Changing speculative decoding there changes the context, which changes
this repo.

What does *not* need changing here is the model name. `opencode-tellico` reads
it from each server's `/v1/models` at launch and rebinds the lead, both workers
and the housekeeping agents to whatever is loaded. Do not reintroduce a
hardcoded model id into that script.

## Architecture boundaries

- `bin/tellico-qwen-tunnel` owns the SSH control socket and port forwards.
  Everything else goes through it; do not open ad-hoc tunnels.
- `bin/opencode-tellico` selects the lead node, resolves each node's model by
  asking it, and injects runtime config via `OPENCODE_CONFIG_CONTENT`.
  OpenCode's interactive command rejects `--model`, so the model and lead agent
  must travel through that env var. Two placement rules live there and are
  deliberate, not incidental. Title, summary and compaction go to the node that
  is *not* hosting the lead, keeping them off the lead's slots. And the two
  workers stay pinned one per node only while both nodes serve the same model;
  when the models differ, both move to the node the lead is not on, so the
  bulk reading lands on one model and the lead keeps its own slots. Preserve
  both if you touch `runtime_config`.
- `lib/checks.sh` holds shared validation used by both `install.sh` and
  `doctor.sh`. Add checks there, not in one caller.
- Agents: one lead (`orchestrate-tellico-0|1`) plus two node-pinned workers.
  `prompts/orchestrate.md` is always-on context for the lead, so every line
  added costs tokens on every turn. Keep it tight.
