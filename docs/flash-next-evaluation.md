# Flash-Next: what it would buy, and what it would cost

Measured from the GGUF metadata and the running service on 2026-10-08, job
15991. Nothing here has been applied. The swap needs a server restart, so it
belongs at an allocation boundary, and -- see the host-memory section -- it
needs a measurement before it is worth doing at all.

## Why the question comes up

The 98,304-token window is `QWEN38_CTX / QWEN38_SLOTS` = 196,608 / 2, and
196,608 is as far as the current model goes: both V100s are full, with 847 MiB
free on GPU0 and **81 MiB on GPU1**, which binds because KV is layer-split.
KV is already `q8_0` on K and V with flash attention on, so the usual
quantization win is already spent. Every remaining lever trades something:

| Change | Per-slot context | Cost |
|---|---:|---|
| `QWEN38_SLOTS=1` | 196,608 | concurrency 4 -> 2 cluster-wide |
| `-ctk q4_0 -ctv q4_0` | 131,072 | long-context and tool-call precision |
| `QWEN38_SPEC_TYPE=none` | ~107,500 | the 2.7x code speedup |

Flash-Next is the only option that changes the arithmetic instead of trading
against it.

## The KV arithmetic

Both models are trained to 262,144 tokens. Per token of context, KV cost is
proportional to `block_count x head_count_kv x (key_length + value_length)`:

| | arch | layers | KV heads | k/v len | KV units per token |
|---|---|---:|---:|---:|---:|
| Qwen3.8-27B | `qwen35` | 64 | 4 | 256 | 131,072 |
| Qwen3.8-Flash-Next | `qwen4exp` | 48 | 2 | 256 | **49,152** |

**Flash-Next needs 2.67x less KV per token.** That is what makes a large window
cheap, and it is the whole case for the swap.

Two caveats on that number. First-principles arithmetic says the 27B's KV at
`q8_0` should be 136 KiB/token, or 25.5 GiB for 196,608 tokens -- which cannot
be true, since it demonstrably fits in the ~13 GiB left after 16.8 GiB of
weights. So some layers are not holding full-context KV (sliding-window or
hybrid attention, which these metadata keys do not expose). The *ratio* is an
architecture-level property and is the part to trust; the absolute figures are
not. Second, if the two models differ in how much of that hybrid structure
they use, even the ratio shifts. Read the real allocation at load time before
believing either.

If the ratio holds, the current KV budget would buy roughly 262,144 tokens of
pool at 2 slots (131,072 each, +33%), or 196,608 at 3 slots (65,536 each,
trading window for the concurrency that actually limits 4-5 users), or some
point between. Smaller KV would also free room to raise `--ubatch-size` above
its current 128, which is what holds prompt processing at 357 tok/s and makes
a cold 40k prompt cost ~112 s.

## The cost nobody had priced: host memory

Flash-Next is a sparse MoE -- `expert_count` 512, `expert_used_count` 10 --
and `Qwen3.8-Flash-Next-UD-IQ4_XS` is **88 GB** across three shards:

```text
00001-of-00003      11 MB    (metadata shard, 0 tensors)
00002-of-00003    47.5 GB
00003-of-00003    41.8 GB
```

88 GB cannot go in 32 GiB of VRAM, so the experts must live in host memory and
stream per token. That is what `--n-cpu-moe` is for, and it is the reason this
machine is a plausible host at all: the AC922 has CPU-GPU NVLink, roughly 3x
the bandwidth of PCIe, so expert streaming is far less punishing here than on
a conventional node.

But the compute node has 155 GB of RAM, of which 82 GB is in use and 66 GB
available today. The current service holds 18 GB of weights plus a 48 GiB
(`QWEN38_CACHE_RAM=49152`) prompt cache. Flash-Next would want:

```text
88 GB  weights, resident
48 GiB prompt cache, as configured today
-----
~140 GB of a 155 GB node, before slots, checkpoints and the OS
```

**So Flash-Next and the current prompt cache are in direct competition for host
RAM.** The prompt cache is not a nice-to-have: it is running at a **91.2% hit
rate**, and that is what keeps a long agentic session affordable, because a
miss on a 40k context costs ~112 s of reprocessing. Shrinking it to fit the
weights would raise context while lowering the hit rate -- and for 3-5
concurrent users, cache-affinity collapse is a bigger performance risk than a
small window.

This is why the swap is not a config edit. It is a trade of prompt-cache
capacity and per-token expert streaming against context and slots, and the
sign of the result is genuinely unknown.

## It is not a config edit: the cluster repo has no MoE knob

`lib/service.sh` in `qwen38-cluster` defines these and nothing else:

```text
QWEN38_CTX  QWEN38_SLOTS  QWEN38_MODEL  QWEN38_MODEL_ALIAS  QWEN38_PORT
QWEN38_SPEC_TYPE  QWEN38_SPEC_DRAFT_MODEL  QWEN38_SPEC_DRAFT_NGL
QWEN38_SPEC_N_MAX  QWEN38_CACHE_RAM  QWEN38_CACHE_IDLE_SLOTS
QWEN38_CTX_CHECKPOINTS  QWEN38_CHECKPOINT_MIN_STEP  ...
```

There is no `--n-cpu-moe` equivalent, and no override-tensor option either. An
88 GB model on 32 GiB of VRAM cannot run without one, so adopting Flash-Next
needs a code change in `qwen38-cluster` to add that flag -- not a line in
`service.env`. Budget for that before planning the swap.

Also worth knowing before starting: `qwen38-submit` refuses to run while a job
of the same name is active, so the swap means `qwen38-stop` first and a real
outage for everyone, not an overlap.

## What to measure, in order

All of this needs the GPUs, so it needs an allocation where nobody is working.

1. **Load Flash-Next at `--ctx-size 196608 --parallel 2` and read the real KV
   allocation.** This confirms or kills the 2.67x ratio. Everything else
   depends on it.
2. **Find the `--n-cpu-moe` split that fits** alongside a prompt cache worth
   having. Record the resident set, not just what fits: the notes on this
   already warn about a lopsided `ncmoe` and an address-space cap.
3. **Measure generation and prompt throughput** against today's baselines of
   **45.1 tok/s** generation and **357 tok/s** prompt. Expert streaming over
   NVLink will cost something per token; the question is how much.
4. **Measure the prompt-cache hit rate** at whatever `QWEN38_CACHE_RAM` is
   left. `tellico-gateway monitor` reports it live, which it did not when this
   configuration was last tuned. Below roughly 80% the swap is probably a
   regression for agentic use regardless of the bigger window.
5. **Only then** decide the `QWEN38_CTX` / `QWEN38_SLOTS` split, and update
   `limit.context` and the model display names in `config/opencode.json` to
   match -- the coupling described in `AGENTS.md`.

## If it is adopted

Cluster side, in `/data/gclab/qwen38/service.env`: the model path, the MTP
draft (`mtp-Qwen3.8-Flash-Next-*.gguf` is already downloaded, in shared and
non-shared variants), `--n-cpu-moe`, a revised `QWEN38_CACHE_RAM`, and
`QWEN38_CTX` / `QWEN38_SLOTS`.

Client side, in this repository: `limit.context` for both providers, the `96k`
in the two model display names, and `TELLICO_GATEWAY_CONTEXT`, which the
gateway installer derives from `config/opencode.json` -- so rerun
`gateway/install-gateway.sh` on the gateway host afterwards.

Nothing about the two client modes, the gateway, or the agent definitions
changes: they are all keyed on provider and model id, not on the model behind
them.
