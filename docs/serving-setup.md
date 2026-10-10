# The Tellico serving setup

What runs on Tellico today, how a request reaches it, how fast it is, and how
to change it. This is the service; the machine itself is described in
[`tellico-cluster.md`](tellico-cluster.md).

State as of 2026-10-09, Slurm job 16012. Every number below was measured on
the cluster that day; the raw results are in
`/home/bbogale/qwen38-bench/results/gsq-*.json`, `.out` and `.log`, written by
`/home/bbogale/qwen38-bench/gsq_validate.py`.

## At a glance

| | |
|---|---|
| Model | Qwen3.8-27B, ISTA-DASLab GSQ-RCO `IQ3_S` (non-uniform per-tensor quantisation, 11.77 GB) |
| Speculative decoding | Qwen3.8-27B DFlash2 drafter (Q4_K_M), draft length 7 |
| Model id | `qwen3.8-27b-gsq-iq3s` (the gateway also accepts `qwen3.6-35b-a3b` and `qwen3.8-27b`) |
| Runtime | llama.cpp `c25030496`, `build-v100-mmq` (sm_70, forced MMQ kernels) |
| Servers | one `llama-server` per GPU node, spanning both V100s, `tellico-compute0` and `tellico-compute1` |
| Slots | 2 per node, 4 cluster-wide |
| Context | 131,072 tokens per request |
| Speed, one request on code | 72-86 tok/s |
| Speed, two requests on one node | 52-70 tok/s each |
| Speed, a session 64-110k tokens deep | ~33 tok/s alone, ~20 each with two that deep |
| Prompt reading, cold | 656 tok/s at 4k, 505 at 70k, 431 at 109k (a fresh 110k prompt: ~4 min) |
| Thinking | graded: `off`, `low`, `medium` (server default), `xhigh` |

## How a request gets there

```text
OpenCode (opencode-tellico)                     other clients (curl, SDKs)
  lead: orchestrate-tellico-0|1 -> tellico-N        |
  workers: tellico-worker-N -> tellico-N-worker      | HTTPS, per-user key
           (sends X-Tellico-Role: worker)            v
  |                                         gateway on lab-pc (tailnet funnel)
  | tunnel mode                               https://lab-pc.tail960ade.ts.net/v1
  |   127.0.0.1:18080 -> compute0:8000        max 3 in flight, leads first
  |   127.0.0.1:18081 -> compute1:8000        routes to the less-busy node
  +------------------+-----------------------------+
                     v
   tellico-compute0:8000          tellico-compute1:8000
   llama-server, 2 slots          llama-server, 2 slots
```

- **Tunnel mode** needs a cluster account; `tellico-qwen-tunnel` owns the SSH
  forwards. **Gateway mode** needs only a URL and a key.
- OpenCode pins its agents: the lead runs on the node derived from
  `$USER@$(uname -n)`, `tellico-worker-0` on node 0 and `tellico-worker-1` on
  node 1. Workers go through the `tellico-N-worker` providers, which point at
  the same servers but label their requests `X-Tellico-Role: worker`.
- **Lead priority** lives only in the gateway: a worker request waits while
  any lead is queued, and workers together never hold every gateway slot.
  Tunnel-mode requests reach llama-server directly, which serves strictly
  first come, first served, so there a fourth request on a node simply waits
  for a slot.

## The server on each node

The live command line, read from `/proc` on compute0 (compute1 is identical):

```text
build-v100-mmq/bin/llama-server
  --model   /home/bbogale/models/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf
  --alias   qwen3.8-27b-gsq-iq3s
  --host 0.0.0.0 --port 8000 --api-key-file /data/gclab/qwen38/secrets/api-key
  --ctx-size 262144 --parallel 2                 # 2 slots x 131072
  --n-gpu-layers 999 --split-mode layer --tensor-split 1,1
  --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on
  --batch-size 1024 --ubatch-size 256
  --threads 32 --threads-batch 64 --cont-batching
  --jinja --reasoning auto --reasoning-format deepseek --reasoning-effort medium
  --metrics --no-warmup
  --cache-ram 49152 --ctx-checkpoints 2          # bounded prompt cache, unchanged
  --spec-type draft-dflash
  --spec-draft-model /home/bbogale/models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf
  --spec-draft-n-max 7 --spec-draft-ngl 999
```

VRAM in use: 12.8 / 14.1 GiB at load, 13.1 / 14.3 GiB at the end of a full
validation including two warm 110k sessions, of 16 GiB each.

- **Layer split.** The two V100s sit on different sockets with no NVLink
  between them. `--split-mode row` does not load in this build ("device
  CUDA0 does not support split buffers").
- **Forced MMQ at ubatch 256.** The IQ quant types take a slow path in the
  default build at ubatch 128 (298 tok/s on a 4k prompt). `build-v100-mmq`
  at ubatch 256 reads the same prompt at 656 tok/s with identical decode
  speed. Forcing cuBLAS instead ran out of VRAM at the first request.
- **Per-slot KV cache.** Each request is hard-capped at 131,072 tokens by the
  server itself.

## Measured performance

Per request, one node, tok/s. All with DFlash2 unless noted.

| | 1 at once | 2 at once | 3 at once |
|---|---:|---:|---:|
| Short code prompts | 72-86 | 52-70 | third waits for a slot |
| Warm 64k session | 33 | -- | -- |
| Warm 110k session | 33 | 20 each (64k + 110k together) | -- |
| Without DFlash2, short code | 34 | 29-31 | -- |

Three users on one node, three short requests at once: two run immediately,
the third queues; walls 8-14 s against ~16 s for three slots without the
drafter.

Validation, all passing on this model: tool calls (single, parallel, and a
round trip feeding a result back), reasoning history preserved between turns
and inside a tool loop, and memory within limits through every test.

### Coding suite

Twelve unit-tested programming tasks (regex matching, a calculator with unary
minus, median of two sorted arrays, skyline, LRU cache, topological sort,
Sudoku, word ladder, weighted interval scheduling, tree serialisation, minimum
window, infix-to-RPN), thinking on, 12,000-token budget, two at a time.

| Model | Passed | Total time |
|---|---:|---:|
| Qwen3.6-35B-A3B + DFlash2 (replaced) | 4/12 | 746 s |
| **Qwen3.8-27B GSQ IQ3_S + DFlash2 (current)** | **11/12** | 387 s |
| Qwen3.8-27B Q4_K_M + DFlash2 (the earlier 2 x 98k profile) | 12/12 | 221 s |

Eight of the 35B's failures were the whole budget spent thinking. The Q4_K_M
profile is as good on this suite and a little faster, but with its drafter it
fits only 98k per request; at 128k it would have to drop DFlash2, which is
worth 2.3x here. Twelve tasks is a small sample.

## Configuration: where it lives

| What | Where |
|---|---|
| Site config (model, runtime, slots, drafter, cache) | `/data/gclab/qwen38/service.env`, outside both repos |
| Defaults and knob documentation | `~/qwen38-cluster/lib/service.sh`, `service.env.example` |
| Server launch | `~/qwen38-cluster/bin/serve-node`, under `bin/serve-node-supervised` |
| Client model id, context, worker providers | `config/opencode.json` |
| Gateway settings | `~/.config/tellico-gateway/gateway.env` on the gateway host |

The site config, as set:

```sh
QWEN38_LLAMA_ROOT=/home/bbogale/src/llama.cpp-speedtest/build-v100-mmq
QWEN38_MODEL=/home/bbogale/models/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf
QWEN38_MODEL_ALIAS=qwen3.8-27b-gsq-iq3s
QWEN38_CTX=262144
QWEN38_SLOTS=2
QWEN38_BATCH=1024
QWEN38_UBATCH=256
QWEN38_KV_UNIFIED=0
QWEN38_SPEC_TYPE=draft-dflash
QWEN38_SPEC_DRAFT_MODEL=/home/bbogale/models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf
QWEN38_SPEC_N_MAX=7
QWEN38_SPEC_DRAFT_NGL=999
QWEN38_SPEC_DRAFT_CACHE_TYPE=
QWEN38_CACHE_RAM=49152
QWEN38_CACHE_IDLE_SLOTS=
QWEN38_CTX_CHECKPOINTS=2
```

**The context coupling.** `limit.context` in `config/opencode.json` must
equal `QWEN38_CTX / QWEN38_SLOTS` (262144 / 2 = 131072), for all four
providers, and `limit.input` must be set to the same number so that
`compaction.reserved` is honoured at all. See "The context coupling" in
`AGENTS.md` for why it is otherwise read and discarded.

## Operating it

On the cluster (`ssh tellico`, as `bbogale`):

```sh
~/qwen38-cluster/bin/qwen38-status          # job, nodes, health
~/qwen38-cluster/bin/qwen38-stop            # cancel the job (drops every session)
~/qwen38-cluster/bin/qwen38-submit          # start it; reads service.env
```

The job runs 24 hours and must be resubmitted after that. `service.env` is
read on every submit and whenever the supervisor restarts a crashed node.

On a client: `./doctor.sh`, `opencode-tellico`, `opencode-tellico --think off`.
On the gateway host: `tellico-gateway status`, `doctor`, `monitor`.
Users must restart OpenCode sessions after any change on either side.

### Rolling back to the Qwen3.6-35B-A3B service

Everything the 35B ran on was saved before the switch:

| Saved | Where |
|---|---|
| Runtime binaries (unchanged in place; copy kept) | `/home/bbogale/rollback-2026-10-09-35b/build-v100-bin`, sha256 recorded below |
| Site config | `/home/bbogale/rollback-2026-10-09-35b/service.env` (also `service.env.35b-dflash-2026-10-09`) |
| Commits | `qwen38-cluster` `1fbfc17`, llama.cpp `c25030496`, client `248cdc6` |
| Gateway and installed client config | `~/.config/tellico-gateway/rollback-2026-10-09-35b/` on the gateway host |

```sh
# Cluster
ssh tellico
cp /home/bbogale/rollback-2026-10-09-35b/service.env /data/gclab/qwen38/service.env
~/qwen38-cluster/bin/qwen38-stop && ~/qwen38-cluster/bin/qwen38-submit

# Client (in the repository), then reinstall
git revert <the commit that switched to qwen3.8-27b-gsq-iq3s>
./install.sh --no-start && ./doctor.sh

# Gateway host
cp ~/.config/tellico-gateway/rollback-2026-10-09-35b/gateway.env ~/.config/tellico-gateway/gateway.env
./gateway/install-gateway.sh && tellico-gateway restart
```

The runtime does not need restoring: `build-v100` was never modified, and the
35B config names it implicitly (no `QWEN38_LLAMA_ROOT`). Its binaries hash to
`llama-server` `fd3025ea...`, `libllama.so.0.6.0` `76f92dfd...`,
`libggml-cuda.so.0.26.0` `049f3c7a...`. The previous Qwen3.8 Q4_K_M profile
is also in `service.env`, commented, as is
`service.env.27b-dflash-2026-10-09`.

## Why this shape

1. **Qwen3.8-Flash-Next was ruled out** (2026-10-07): ~13.5 tok/s at best, its
   experts do not fit the VRAM. See [`flash-next-evaluation.md`](flash-next-evaluation.md).
2. **Qwen3.6-35B-A3B was fast but not good enough.** It served three users
   at 190 tok/s, but passed 4/12 coding tasks and failed tool calls.
3. **The GSQ-RCO IQ3_S file is what makes 128k fit with the drafter.** At
   11 GiB of weights against the Q4_K_M's 17.7, two 131k slots and DFlash2 sit
   at ~13-14 GiB per GPU; the Q4_K_M with DFlash2 could only reach 98k.
4. **DFlash2 is worth 2.3x** on this model (78 against 34 tok/s on code).
5. **A third slot does not fit beside the drafter.** Every variant tried --
   ubatch 256 and 128, a q8 draft cache, 55/45 and 60/40 tensor splits --
   ran out of VRAM on GPU1. Without the drafter three slots fit, but each
   request runs at 24-34 tok/s, slower for everyone than two slots with it.
6. **Unified KV is off.** It fixed an adjacent-slot batching quirk but made
   every pass attend over the whole shared pool, which cost deep sessions far
   more (measured on the 35B).

## Known issues

- **Four slots.** Three users with a lead and a worker each exceed it; extra
  requests queue. Through the gateway, leads go first; in tunnel mode the
  servers are first come, first served.
- **Cold prefill.** ~4 minutes for a fresh 110k prompt. The prompt cache hides
  it for a returning session.
- **Deep sessions are slower.** ~33 tok/s at 64-110k, ~20 each when both slots
  of a node are that deep.
- **GPU copy-engine faults (Xid 31).** Seen on the 27B with a large prompt
  cache and checkpoints, about every four hours under load. The supervisor
  restarts the faulting node in ~30 s; in-flight requests on it fail.
- **Output is not byte-identical** to a non-speculative run.
- **OpenCode 2 clients** ignore the thinking variants and a few other config
  keys (see AGENTS.md); the plugins load on both versions.

## Files on the cluster

| Path | What |
|---|---|
| `/home/bbogale/models/Qwen3.8-27B-GSQ-RCO-IQ3_S.gguf` | the served model, sha256 `64b53b64...0326d810` |
| `/home/bbogale/models/Qwen3.8-27B-DFlash2-Q4_K_M.gguf` | the served drafter, sha256 `1a25c568...db131ebd` |
| `/home/bbogale/models/Qwen3.8-27B-Q4_K_M.gguf` | the earlier Qwen3.8 weights |
| `/home/bbogale/models/Qwen3.6-35B-A3B-*.gguf` | the replaced 35B and its drafters |
| `/home/bbogale/models/fetch-*.sh` | sha256-checked chunked downloaders |
| `/home/bbogale/src/llama.cpp-speedtest/build-v100-mmq` | the production runtime |
| `/home/bbogale/src/llama.cpp-speedtest/build-v100` | the previous runtime, untouched |
| `/home/bbogale/src/llama.cpp-speedtest/build-v100-cublas` | forced-cuBLAS build, rejected (OOM) |
| `/home/bbogale/qwen38-bench/gsq_validate.py`, `gsq_tasks.json` | the validation harness and coding suite |
| `/data/gclab/qwen38/logs/` | per-node server logs |
