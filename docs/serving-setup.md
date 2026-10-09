# The Tellico serving setup

What runs on Tellico today, how a request reaches it, how fast it is, and how
to change it. This is the service; the machine itself is described in
[`tellico-cluster.md`](tellico-cluster.md).

State as of 2026-10-09, Slurm job 16007. Every number below was measured on
the cluster that day; the raw results are in
`/home/bbogale/qwen38-bench/results/multi-*.out` and `.json`.

## At a glance

| | |
|---|---|
| Model | Qwen3.6-35B-A3B (mixture-of-experts, 35B total, 3B active per token), Unsloth `UD-Q4_K_XL` |
| Speculative decoding | DFlash2 drafter, draft length 7 |
| Model id | `qwen3.6-35b-a3b` (gateway also accepts `qwen3.8-27b`) |
| Servers | one `llama-server` per GPU node, `tellico-compute0` and `tellico-compute1` |
| Slots | 3 per node, 6 cluster-wide |
| Context | 131,072 tokens per request |
| Speed, one request on code | ~190 tok/s |
| Speed, two requests on one node | 100-114 tok/s each |
| Speed, a session 64k tokens deep | 84 tok/s alone, 37-51 each with three that deep |
| Prompt reading | ~390-490 tok/s (a fresh 110k prompt takes ~4-5 min) |
| Thinking | on by default; `off` is the only other setting the template honours |

## How a request gets there

```text
OpenCode (opencode-tellico)                     other clients (curl, SDKs)
  lead: orchestrate-tellico-0|1                    |
  workers: tellico-worker-0, tellico-worker-1      | HTTPS, per-user key
  |                                                v
  | tunnel mode                         gateway on lab-pc (tailnet funnel)
  |   ssh port forwards                   https://lab-pc.tail960ade.ts.net/v1
  |   127.0.0.1:18080 -> compute0:8000    admission control, max 4 in flight
  |   127.0.0.1:18081 -> compute1:8000    routes to the less-busy node
  |                                                |
  +------------------+-----------------------------+
                     v
   tellico-compute0:8000          tellico-compute1:8000
   llama-server, 3 slots          llama-server, 3 slots
   2 x V100 16 GB                 2 x V100 16 GB
```

- **Tunnel mode** (`TELLICO_MODE=tunnel`) needs a cluster account.
  `tellico-qwen-tunnel` owns the SSH control socket and both forwards.
- **Gateway mode** (`TELLICO_MODE=gateway`) needs only a URL and a key. The
  gateway runs on an always-on host in tunnel mode and forwards to the same
  two ports; `/v1/node0` and `/v1/node1` pin a node. It has 4 user keys today.
- Both nodes serve the same model, so a request can go to either. OpenCode
  pins its agents: the lead runs on the node derived from `$USER@$(uname -n)`
  (stable per device, for prompt-cache affinity), `tellico-worker-0` on node 0
  and `tellico-worker-1` on node 1. Title, summary and compaction go to the
  lead's node.

## The server on each node

The live command line, read from `/proc` on compute1 (compute0 is identical):

```text
llama-server
  --model   /home/bbogale/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
  --alias   qwen3.6-35b-a3b
  --host 0.0.0.0 --port 8000 --api-key-file /data/gclab/qwen38/secrets/api-key
  --ctx-size 393216 --parallel 3                 # 3 slots x 131072
  --n-gpu-layers 999 --split-mode layer --tensor-split 1,1
  --cache-type-k q8_0 --cache-type-v q8_0 --flash-attn on
  --batch-size 1024 --ubatch-size 256
  --threads 32 --threads-batch 64 --cont-batching
  --jinja --reasoning auto --reasoning-format deepseek --reasoning-effort medium
  --metrics --no-warmup
  --cache-ram 49152 --ctx-checkpoints 2          # host-side prompt cache
  --spec-type draft-dflash
  --spec-draft-model /home/bbogale/models/Qwen3.6-35B-A3B-DFlash2-Q4_K_M.gguf
  --spec-draft-n-max 7 --spec-draft-ngl 999
  --spec-draft-type-k q8_0 --spec-draft-type-v q8_0
```

VRAM in use: 15.2 GiB on GPU0 and 14.9 GiB on GPU1, of 16 GiB each.

Notes on the choices:

- **Layer split, not tensor split.** The two V100s in a node have no NVLink
  between them, so llama.cpp runs GPU0's layers and then GPU1's. A second GPU
  adds memory, not speed.
- **Per-slot KV cache, not unified.** See [Why this shape](#why-this-shape).
  With per-slot KV each request is hard-capped at 131,072 tokens by the server
  itself.
- **The drafter's KV cache must be q8_0.** At f16 the drafter does not fit
  beside three slots.
- **`--reasoning-effort medium` does nothing here.** The Qwen3.6 chat
  template only reads `enable_thinking`. It is left in because the cluster
  scripts pass it to whatever model is configured.
- **Prompt cache.** 48 GiB of host RAM holds slot state so a returning
  conversation skips re-reading its prefix. `--ctx-checkpoints 2` keeps the
  rollback point this hybrid model needs for that, while bounding the snapshot
  build-up that faulted the GPU (see [Known issues](#known-issues)).

## Measured performance

Per request, one node, tok/s. "Short" means a prompt of a few hundred tokens;
"64k deep" means three sessions each holding ~64k tokens of context on the
node, with the request reusing its cached prefix.

| | 1 at once | 2 at once | 3 at once |
|---|---:|---:|---:|
| Short, live code prompts | ~190 | 100-114 | -- |
| Short, benchmark text | 110 | 63-78 | 57-63 |
| 64k deep | 84 | -- | 37-51 |

How much DFlash2 helps depends on what is being written. Its drafts were
accepted 70-80% of the time on code and about 35% on the benchmark's filler
text, which is why the same setup shows 190 in one row and 110 in the other.
Expect the lower figures for prose.

Prompt reading does not benefit from the drafter: ~480 tok/s on a 4k prompt,
~380 on a 110k one.

## Configuration: where it lives

Nothing about the model is hardcoded on the client. The cluster side decides
what is served and the client is told the id and the context.

| What | Where |
|---|---|
| Site config (model, slots, drafter, cache) | `/data/gclab/qwen38/service.env`, outside both repos |
| Defaults and knob documentation | `~/qwen38-cluster/lib/service.sh`, `service.env.example` |
| Server launch | `~/qwen38-cluster/bin/serve-node`, under `bin/serve-node-supervised` |
| Slurm job | `~/qwen38-cluster/qwen38.sbatch`, submitted by `qwen38-submit` |
| Client model id and context | `config/opencode.json` (`qwen3.6-35b-a3b`, `limit.context` 131072) |
| Gateway settings | `~/.config/tellico-gateway/gateway.env` on the gateway host |

The site config, as set:

```sh
QWEN38_MODEL=/home/bbogale/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf
QWEN38_MODEL_ALIAS=qwen3.6-35b-a3b
QWEN38_CTX=393216
QWEN38_SLOTS=3
QWEN38_BATCH=1024
QWEN38_UBATCH=256
QWEN38_KV_UNIFIED=0
QWEN38_SPEC_TYPE=draft-dflash
QWEN38_SPEC_DRAFT_MODEL=/home/bbogale/models/Qwen3.6-35B-A3B-DFlash2-Q4_K_M.gguf
QWEN38_SPEC_N_MAX=7
QWEN38_SPEC_DRAFT_NGL=999
QWEN38_SPEC_DRAFT_CACHE_TYPE=q8_0
QWEN38_CACHE_RAM=49152
QWEN38_CACHE_IDLE_SLOTS=
QWEN38_CTX_CHECKPOINTS=2
```

**The context coupling.** `limit.context` in `config/opencode.json` must equal
`QWEN38_CTX / QWEN38_SLOTS` (393216 / 3 = 131072). Change the slot count or
the context and the client config, the model display names (`128k`) and the
gateway's `TELLICO_GATEWAY_CONTEXT` all have to follow.

## Operating it

On the cluster (`ssh tellico`, as `bbogale`):

```sh
~/qwen38-cluster/bin/qwen38-status          # job, nodes, health
~/qwen38-cluster/bin/qwen38-status --wait   # follow a startup
~/qwen38-cluster/bin/qwen38-stop            # cancel the job (drops every session)
~/qwen38-cluster/bin/qwen38-submit          # start it; reads service.env
```

The job runs for 24 hours and must be resubmitted after that. A change to
`service.env` takes effect on the next submit, and also whenever the
supervisor restarts a crashed node, so do not leave a half-edited file there.

On a client:

```sh
./doctor.sh                 # everything, in dependency order
tellico-qwen-tunnel status  # the SSH forwards
opencode-tellico            # start a session (lead node from this device)
opencode-tellico 1          # lead on node 1 explicitly
opencode-tellico --think off
```

On the gateway host: `tellico-gateway status`, `doctor`, `logs`, `monitor`.

OpenCode reads its config once at startup, and restarting the service drops
every open connection, so after any cluster change users must restart their
sessions.

### Rolling back

Two previous site configs are kept next to the live one:

| File | What it was |
|---|---|
| `service.env.35b-kvu-2026-10-09` | Same model, unified KV, no drafter, 4 slots per node |
| `service.env.27b-dflash-2026-10-09` | Qwen3.8-27B with its own DFlash2 drafter, 2 x 98k per node |

Copy one over `service.env` and resubmit. Going back to the 27B also means
reverting the client's model id and context (`config/opencode.json`,
`bin/opencode-tellico`, `lib/checks.sh`, the gateway defaults), then
`./install.sh --no-start` and the gateway installer. Going back to the 4-slot
35B config needs no client change.

## Why this shape

The goal was three concurrent users, 128k context, and as much speed and
capability as the hardware allows. Each step below was measured before it
was adopted.

1. **Qwen3.8-Flash-Next was ruled out** (2026-10-07). It tops out near
   13.5 tok/s: its experts do not fit in 32 GB of VRAM, and no quant fits even
   across both nodes. See [`flash-next-evaluation.md`](flash-next-evaluation.md).
2. **Qwen3.8-27B is the stronger model but cannot serve three users.** It
   fits two 128k slots per node, runs ~32 tok/s alone and ~24 each with two,
   and falls to 18.7 tok/s at 110k of context. SWE-bench Pro 61.7.
3. **Qwen3.6-35B-A3B fits twice the slots at three times the speed.** With
   only 3B parameters active per token it ran 94 tok/s alone and 56 each with
   four, and held 55 tok/s at 110k. SWE-bench Pro 49.5: this is the
   capability given up. The Q6_K quant was rejected because only one 128k slot
   fits.
4. **Unified KV fixed one problem and caused another.** On this hybrid model
   llama.cpp batches only *adjacent* slots into one decode pass unless the KV
   cache is unified, so two requests in slots 0 and 2 ran 33 tok/s each.
   `--kv-unified` fixed that (77-80 each), but a unified cache makes every pass
   attend over the whole shared pool: one 64k-deep session fell from 68 to 42
   tok/s while two others held the node.
5. **DFlash2 wins where agentic sessions live.** On a per-slot cache it took
   a 64k-deep session to 84 tok/s and three of them to 37-51 each, against 42
   and 28 on the unified setup, and it did not show the adjacent-slot collapse
   in any run. It costs one slot per node, which is why there are three.
6. **MTP was measured and rejected.** Unsloth's MTP build of the same quant
   (`Qwen3.6-35B-A3B-MTP-UD-Q4_K_XL.gguf`) runs +34% for a lone request but
   fits only three slots, and does not fit at all with unified KV.

## Known issues

- **Prompt reading is slow.** ~390-490 tok/s. The prompt cache hides most of
  it for a continuing conversation, but a fresh long prompt waits minutes.
- **Six slots.** Three users with a lead and one worker each fill the
  cluster; any further request queues. The gateway holds at most four so a
  direct session always has room.
- **Capability.** SWE-bench Pro 49.5 against the 27B's 61.7. If answers are
  not good enough for real work, the 27B config is one file copy away.
- **GPU copy-engine faults (Xid 31).** Seen on the 27B with a large prompt
  cache and context checkpoints, about once every four hours under load; not
  yet seen on this model. The supervisor restarts the faulting node in ~30 s
  and the other keeps serving, but requests in flight on that node fail.
- **Output is not byte-identical.** Speculative decoding evaluates a block of
  tokens per pass, so a response is a valid sample but will not match a
  non-speculative run token for token.
- **Thinking levels.** `low`, `medium` and `xhigh` all mean "on" with this
  template; only `off` changes anything.

## Files on the cluster

| Path | What |
|---|---|
| `/home/bbogale/models/Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` | the served model (22.4 GB) |
| `/home/bbogale/models/Qwen3.6-35B-A3B-DFlash2-Q4_K_M.gguf` | the served drafter (315 MB); a Q8_0 sits beside it |
| `/home/bbogale/models/Qwen3.6-35B-A3B-MTP-UD-Q4_K_XL.gguf` | MTP build, measured and not used |
| `/home/bbogale/models/Qwen3.6-35B-A3B-UD-Q6_K.gguf` | older upload, also an MTP build; fits one slot |
| `/home/bbogale/models/Qwen3.8-27B-*.gguf` | the previous model and its drafters |
| `/home/bbogale/models/fetch-*.sh` | sha256-checked chunked downloaders |
| `/home/bbogale/src/llama.cpp-speedtest/build-v100` | the llama.cpp build (commit c25030496) |
| `/home/bbogale/qwen38-bench/run_bench_multi.py` | the benchmark harness behind every number here |
| `/data/gclab/qwen38/logs/` | per-node server logs |
