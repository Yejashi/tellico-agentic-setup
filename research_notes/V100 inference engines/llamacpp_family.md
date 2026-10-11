# Faster Qwen3.8-27B on 2x V100-SXM2-16GB within the llama.cpp family (as of 2026-10-10)

Setting recap: AC922, 2x V100-SXM2-16GB with NVLink per node, ppc64le. Current build is upstream-style llama.cpp CUDA with FORCE_MMQ, IQ3_S (~11.8 GB), layer split, DFlash2 drafter (accept ~0.35, n-max 7), 2 slots x 131072. Measured 72-86 tok/s short, ~33 tok/s at 64-110k, prefill 430-650 tok/s.

## Q1. Which fork or engine change is most likely to raise tok/s on V100? (ik_llama.cpp, V100-specific forks, upstream tensor split)

### Takeaway
The best lead is not ik_llama.cpp. It is the V100-specific forks: **1115714829/llama.cpp-v100**, which targets exactly Qwen3.8-27B + DFlash2 on AC922 with `--split-mode tensor` over NCCL, and **Mitsuasa513/llama.cpp-v100-tuning**, with Volta FA and MMVQ kernels claiming +24% decode at 90k and +36-57% prefill on Qwen3.8-27B. ik_llama.cpp does support Qwen3.5/3.8, MTP and DFlash, but it officially does not support Volta, and its maintainer has declined to tune for it.

### Cited Findings
**ik_llama.cpp**
- The README news lists Qwen3-Next (PR 1266), Qwen3.5-MoE (PR 1288), dense Qwen3.5 (PR 1326), Qwen3.5/3.6 MTP (PRs 1698, 1745), fused delta-net (PRs 1315/1333/1362/1373), Qwen3.8-Flash-Next (PR 2365), Qwen3.8 MTP including standalone MTP heads via `-md` (PR 2369), DFlash initial support (PR 1970), n-gram self-speculation (PR 1261), suffix decoding (PR 1646), and split mode "graph" for multi-GPU (PR 1022). The README dates few of these items. — [ik_llama.cpp README](https://github.com/ikawrakow/ik_llama.cpp)
- The README describes CUDA support as "Turing or newer" (compatibility extended to Turing on 2025-05-11, PR 408) and asks users not to file issues about old NVIDIA GPUs. Some users saw gibberish with graph split mode, and the suggested fix is `-cuda graphs=0`. — [ik_llama.cpp README](https://github.com/ikawrakow/ik_llama.cpp)
- In issue #2463 (2026-09-16), ikawrakow said Volta would only be supported if a dedicated tester and maintainer stayed around, and that otherwise it was "wasted effort". He listed the problems as no FA for some MLA models, possible bf16 issues, and "many kernels and launch parameters are poorly tuned for Volta". He suggested mainline llama.cpp may be a better home for Volta users. The thread has no V100 benchmarks. — [ik_llama.cpp #2463](https://github.com/ikawrakow/ik_llama.cpp/issues/2463)
- ik-llama-server aborted on a V100 on its first FA call (`fattn-wmma-f16.cuh`) because the image was built without sm_70. On CC 7.0, ik picks the WMMA FA path. The fix (2026-09-28) was to compile sm_70. The thread has no post-fix performance numbers. — [llama-swap #1185](https://github.com/mostlygeek/llama-swap/issues/1185)
- ik PR #2509 (merged 2026-09-23) shows ik does run on sm_70. On a Titan V (Volta), IQ4_K tg128 for Qwen3.5-4B went from 107.27 to 132.59 t/s (measured). It also notes that block-size-16 quants do not get MMQ speeds as good as block-32 quants. — [ik_llama.cpp PR #2509](https://github.com/ikawrakow/ik_llama.cpp/pull/2509)
- The issue for Qwen3.8-27B silent EOS beyond about 100-130k reproduces on ik_llama.cpp too, so switching to ik does not avoid it. — [llama.cpp #27756](https://github.com/ggml-org/llama.cpp/issues/27756)

**V100-specific forks**
- **1115714829/llama.cpp-v100** (v1.1.1, measured 2026-10-06) is a "V100 (sm_70) 专项优化版" (V100-specialized build). It targets Qwen3.8-27B on IBM Power AC922 with 6x V100-SXM2-16GB NVLink and CUDA 12.4. It ships DFlash2 (`--spec-type draft-dflash --spec-draft-n-max 7`) and uses `--split-mode tensor --tensor-split 1,1` with `-DGGML_CUDA_NCCL=ON`. It sets `NCCL_P2P_LEVEL=SYS` automatically on ppc64le and recommends `numactl --membind=0,8`, because the AC922 exposes GPU memory as NUMA nodes. MTP is listed as "next steps" for 2.0.0. — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100); [release v100-1.1.1](https://github.com/1115714829/llama.cpp-v100/releases/tag/v100-1.1.1)
- Its 2-card numbers (author-measured; the Q4 rows are from older versions, and the author says Q4 decode later got about 10% faster):
  - UD-Q4_K_M target, F16 draft, 131072 ctx: real 16K prompt prefill 1861 tok/s, decode 63.4 tok/s, 13.7 GB/card.
  - Q4_K_M draft, 262144 ctx: real 16K prefill 1841, decode 78.6.
  - "Synthetic" long-input decode figures (162-184 tok/s) are inflated by an easily drafted synthetic prompt. Do not compare them with real workloads. — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100)
- Same fork, 4 cards, Q8 target, real code prompts (1.0.4, 2026-09-29/30): 131,184 tokens gives 1966 prefill and 102.6 decode, 209,228 tokens gives 1635 prefill and 88.0 decode. DFlash2 acceptance is about 0.22-0.25 there. The fork recommends `-b 2048 -ub 2048` (`-ub 4096` gave little or no gain). — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100)
- Same fork, `-np 2` on 4 cards: a single 16K request decodes at 120.9 tok/s, while two concurrent requests get 84.1 and 103.6 tok/s per stream. The author says prefill is queued. — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100)
- **Mitsuasa513/llama.cpp-v100-tuning** (branch `v100-sm70-tuning` on upstream `df03399b`, +930/-86 lines, undated) changes four things:
  - Decode FA reads the q8_0 KV cache directly into shared-memory tiles, and GQA heads sharing a KV head share a tile.
  - Prefill FA uses Volta tile configs that fit 2 blocks per SM instead of 1.
  - Activation quantization runs once per graph pass.
  - rms_norm and scale are fused, and MMVQ has a Volta-specific table.
- Its claims on one V100-32GB with Qwen3.8-27B Q4_K_M, `-fa on`, q8_0 KV (author-measured, absolute numbers only in chart images): decode +24% at 90k and +52% at 262k, prefill +36-57%. Prefill at 90k depth with `-b 4096 -ub 4096` went from 501 to 726 t/s. f16 KV is about 5% faster than q8_0 up to about 240k. Env switches `GGML_V100_FA=vec|tile|mma` and `GGML_V100_UPSTREAM_BUILD=1` allow A/B testing. — [Mitsuasa513 README](https://raw.githubusercontent.com/Mitsuasa513/llama.cpp-v100-tuning/v100-sm70-tuning/README.md)

**Upstream tensor parallelism**
- Upstream `--split-mode tensor` (PR #19378) merged on 2026-04-09. It is a "meta" backend that splits tensors across GPUs and recommends NCCL. It requires FA on and an explicit `--ctx-size` (no `-fit`).
- KV cache quantization had to be off. The LocalAI note says #23792 later lifted that restriction.
- Qwen3.5 27B and 35B-A3B were benchmarked and are not on the broken list. Mamba-family, granite_hybrid, jamba, nemotron_h and kimi_linear are broken.
- On 4090s, decode often gains (2x4090 Llama-8B F16 tg 60.3 to 96.6, 1.60x) while prefill often loses (0.39-0.64x).
- Known issues: a VRAM leak from re-created CUDA graphs (OOM as context grows) and memory over-allocation. — [llama.cpp PR #19378](https://github.com/ggml-org/llama.cpp/pull/19378); [LocalAI commit note](https://gitea.varghacsongor.hu/GithubMirror/LocalAI/commit/21eace40ecc58a1dcd02f4cef4ecbcff0bf13480)
- A third-party guide reports 2x4090 Llama-3-70B prompt processing at about 1287 tok/s with layer split, 582 with row split and 1072 with tensor mode. — [InsiderLLM](https://insiderllm.com/guides/multi-gpu-local-ai/)

### Inferences
- The user's stack (DFlash2 drafter, AC922, Qwen3.8-27B, `--ctx-checkpoints`) closely matches 1115714829/llama.cpp-v100. They may already be on it or a relative of it. If they are on plain upstream, this fork's tensor split with NCCL over NVLink is the single biggest structural change available. Its 2-card real-prompt decode of 63-79 tok/s at 16K with a Q4 target is comparable to the user's short-prompt 72-86, with a larger quant and much faster prefill (about 1850 vs 430-650 tok/s).
- The "device CUDA0 does not support split buffers" error belongs to the old `-sm row`. `-sm tensor` is a different code path and is the one to try.
- Tensor split halves the per-GPU weight and KV reads per token. On bandwidth-bound decode, that should help most at long depth, which is where the user loses most.
- The Mitsuasa513 Volta kernels target the exact model and the exact long-context weakness. Its patch is small enough to cherry-pick onto whichever base is in use. Combining it with the tensor-split fork is untested by anyone I found.
- ik_llama.cpp is a poor bet on V100. It has no maintainer for Volta, it is admittedly untuned there, it reproduces the same >100k EOS issue, and its unique advantages (CPU-hybrid MoE offload, IQK quants) matter little for a 27B dense model fully in VRAM.

### Gaps
- I found no V100 benchmark of ik_llama.cpp on Qwen3.5/3.8 and no test of ik's "graph" split mode on Volta.
- I found no upstream-vs-fork A/B on 2x V100 NVLink with layer vs tensor split. The v100 fork publishes tensor-split results only.
- I could not read the absolute per-depth numbers in the Mitsuasa513 charts, because they are images only.

## Q2. Upstream llama.cpp on Volta: FA kernels, KV quantization, MMQ, Gated DeltaNet

### Takeaway
Volta is a second-class FA target upstream. The PTX-mma FA rewrite excludes Volta, newer tuning is disabled on it, and Volta FA configs for head size 256 were still being fixed on 2026-10-01. The GDN CUDA kernel is token-sequential, and a chunked prefill kernel was proposed and then closed as not planned. Upstream KV q8_0 helps capacity, not speed (f16 is about 5% faster per the V100 fork).

### Cited Findings
- **FA kernels:**
  - PR #11583 (Feb 2025) moved CUDA FA from WMMA to PTX mma. Volta's tensor cores are incompatible with that code, so V100 keeps the older WMMA kernel. The author mentioned possibly writing a dedicated Volta kernel, and I found no evidence that one was written.
  - PR #11615 fixed Volta kernel-selection logic. — [PR #11583](https://github.com/ggml-org/llama.cpp/pull/11583); [PR #11615](https://github.com/ggml-org/llama.cpp/pull/11615)
  - PR #19092 (faster FA for GQA ratios that are not powers of 2): "on Volta the new code path is slower than master so it's disabled". — [PR #19092](https://github.com/ggml-org/llama.cpp/pull/19092)
  - PR #29803 (merged 2026-10-01) fixed Volta FA crashes for head sizes 256 and 320. Volta had been using Ampere configs, which needed too much shared memory. Related issues include Qwen3.5-122B-A10B and Qwen3.8-Flash-Next crashing on sm_70. — [PR #29803](https://github.com/ggml-org/llama.cpp/pull/29803)
- **KV cache type:** With a Volta-tuned kernel, f16 KV is about 5% faster than q8_0 up to roughly 240k (single-author measurement, fork code, not upstream). — [Mitsuasa513 README](https://raw.githubusercontent.com/Mitsuasa513/llama.cpp-v100-tuning/v100-sm70-tuning/README.md)
- **Gated DeltaNet:**
  - The fused GATED_DELTA_NET op (CPU+CUDA) came in PR #19504 (b8233). — [PR #19504](https://github.com/ggml-org/llama.cpp/pull/19504)
  - RFC #22967 (2026-05-12) noted the CUDA kernel still has a TODO for chunked prefill and that large prompts run token-sequentially. It gave no measurements and was closed "not planned" on 2026-06-27. A maintainer said a TF32 tensor-core branch "beats the AR kernel at higher batch sizes", and TF32 does not exist on Volta. — [issue #22967](https://github.com/ggml-org/llama.cpp/issues/22967)
  - A fork reports a chunked tensor-core GDN prefill kernel at T=512 going from 1095.8 to 350.9 µs on an RTX 5070 Ti (self-reported, not upstream). — [torad-labs PR #10](https://github.com/torad-labs/llama.cpp/pull/10)
  - The Mitsuasa513 fork's optional SSM fusion adds only about 0.3%. — [Mitsuasa513 README](https://raw.githubusercontent.com/Mitsuasa513/llama.cpp-v100-tuning/v100-sm70-tuning/README.md)
- **Correctness risk at the user's depth:**
  - Issue #27756 (opened 2026-08-26, no maintainer reply, marked stale 2026-10-08): Qwen3.8-27B emits instant EOS or degraded output at some prompt lengths between about 96k and 243k. Failures are non-monotonic "holes", for example 96,519 and 100,407 fail while 95,979 and 99,003 pass.
  - It reproduces on CUDA, CPU and ik_llama.cpp, and vLLM passed at the same depths.
  - The reporter advises validating the exact serving depths. — [llama.cpp #27756](https://github.com/ggml-org/llama.cpp/issues/27756)
- **Toolkit:** CUDA Toolkit 13.0 dropped Volta, and prebuilt llama.cpp binaries no longer include sm_70, so builds must use CUDA 12.x with `CMAKE_CUDA_ARCHITECTURES=70`. — [search summary citing V100 community posts](https://daily.dev/posts/the-v100-datacenter-gpu-is-the-cheapest-way-past-24gb-vram-if-you-can-stomach-the-pain-hknhtuol0) (secondary source)

### Inferences
- The GDN layers carry fixed-size state, so they do not grow with depth. The 86 to 33 tok/s collapse almost certainly comes from the 16 full-attention layers' FA over KV, compounded by the speculative verify batch (n-max 7 means about 8 query columns per step), on an untuned WMMA kernel.
  - A rough model, assuming 4 KV heads x 256 head dim (unverified): f16 KV is about 64 KiB/token over 16 layers, so about 6.5 GB is read per verify step at 100k, comparable to the 11.8 GB of weights.
  - That is why Volta-specific FA (Mitsuasa513) and tensor split (halving KV per GPU) are the right levers.
- On this model, CUDA graphs and FORCE_MMQ mostly affect prefill and per-step overhead, not the long-context decode floor.

### Gaps
- I found no upstream measurement isolating GDN vs FA vs matmul time for Qwen3.8 on V100. A `GGML_SCHED`/nsys profile on the user's own node would settle it.
- I did not verify current upstream behaviour for CUDA graphs with `-sm tensor` on Volta.
- I did not verify Qwen3.8-27B's exact KV head count, so the KV-bytes estimate above is an assumption.

## Q3. Which GGUF quant types decode fastest on V100?

### Takeaway
On Volta, decode is bandwidth-bound but far from peak for K-quants: Q4_K_M reached only about 500 GB/s effective on a V100. Block-32 quants (Q4_0, Q8_0, IQ4_XS/NL) tend to get better kernel efficiency than block-16 or codebook quants. IQ3_S is small, but its codebook lookups cost ALU and shared-memory work. I found no V100 head-to-head that includes IQ3_S.

### Cited Findings
- Qwen3.6-27B (dense) on 1x V100-SXM2-32GB, llama.cpp build 6eab47181, 4K ctx, 2026-08-10 (measured, tg128):
  - Q4_K_M (15.65 GiB): 32.17 t/s
  - Q5_K_M (18.16 GiB): 29.14 t/s
  - Q6_K (20.97 GiB): 25.11 t/s
  - Q8_0 (26.62 GiB): 22.80 t/s
  - FA and KV type not reported. — [ahelpme V100 llama-bench](https://ahelpme.com/ai/llamacpp-ai/llama-bench-the-qwen3-6-27b-and-nvidia-tesla-v100-sxm2-32gb/)
- IQ quants use a codebook, and each matmul needs many loads from a lookup table, which is the maintainer's explanation for slow IQ on Apple GPUs. — [llama.cpp discussion #5617](https://github.com/ggml-org/llama.cpp/discussions/5617)
- ik PR #2509: block-size-16 quants get worse MMQ than block-32. IQ4_K mmvq gained +24% on a Titan V after a single byte-gather fix, which shows how sensitive Volta is to the dequant inner loop. — [ik PR #2509](https://github.com/ikawrakow/ik_llama.cpp/pull/2509)
- The V100 fork runs UD-Q4_K_M for the target on 2 cards and Q8_0 on 4+. For the drafter, F16 gives clearly higher acceptance on short tasks (3.23 vs about 2.8 tokens/round), while Q8_0 or Q4_K_M cost little round time when VRAM is tight. — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100)

### Inferences
- Effective bandwidth from the ahelpme table: Q4_K_M ≈ 15.65 GiB x 32.2 ≈ 540 GB/s, and Q8_0 ≈ 26.62 x 22.8 ≈ 650 GB/s, against a nominal ~900 GB/s.
- So on Volta the simpler-dequant Q8_0 extracts more bandwidth than Q4_K. IQ3_S, with grid lookups, is likely below Q4_K in efficiency, which would make its 11.8 GB size advantage smaller than it looks.
- Candidates worth a llama-bench A/B on the user's node at the same depth:
  - Q4_0 or IQ4_XS: block-32, about 14-15 GB, fits 2x16 GB with a split.
  - Q3_K_M.
- For the drafter, F16 or Q8_0 rather than a low-bit quant, because acceptance matters more than draft size.

### Gaps
- I found no V100 measurement of IQ3_S, Q4_0, IQ4_XS or IQ3_K for any 27B model. This must be measured locally.
- I found no data on IQK quant (IQ3_K/IQ4_KS) quality or speed on Volta specifically.

## Q4. Speculative decoding alternatives: MTP, n-gram, draft tuning

### Takeaway
Upstream llama.cpp merged MTP (`--spec-type draft-mtp`, PR #22673, 2026-05-16), but at last report it did not support `-np > 1`, which conflicts with the user's 2 slots. ik_llama.cpp has Qwen3.8 MTP (PR 2369) and n-gram and suffix self-speculation. The V100 fork has DFlash2 but no MTP yet (planned for 2.0.0). The user's DFlash2 acceptance (0.34-0.37) is already above that fork's own 0.22-0.25.

### Cited Findings
- MTP merged into llama.cpp via PR #22673 on 2026-05-16. The flag was renamed `--spec-type mtp` to `--spec-type draft-mtp` on 2026-05-13, and the example uses `--spec-draft-n-max 6`.
- "`-np > 1` and `--mmproj` are not yet supported with MTP."
- Claimed speedup is about 1.5-2x (vendor claim, not measured on V100). — [unsloth Qwen3.5-9B-MTP-GGUF](https://huggingface.co/unsloth/Qwen3.5-9B-MTP-GGUF)
- For Qwen3.6 a separate MTP GGUF is needed. Community guides cite 1.4-2.2x, which is unverified. — [search summary of community guides](https://gist.github.com/eeshansrivastava89/85797104af34181944bfd1360d69e8af)
- Community V100 reports for Qwen 27B Q4_K_M with MTP: about 65 tok/s at 1K ctx (llama.cpp b10793), and about 57 tok/s on a V100-PCIE-32GB. These come from an aggregator and are unverified. — [llamaperf V100](https://llamaperf.com/gpu/v100-32gb)
- Mainline llama-server on a V100 with Qwen3.6-35B-A3B IQ4_XS, FA and MTP ran at about 100 tok/s. — [llama-swap #1185](https://github.com/mostlygeek/llama-swap/issues/1185)
- ik_llama.cpp has Qwen3.8 MTP including standalone MTP heads via `-md` (PR 2369), DFlash (PR 1970), n-gram (PR 1261) and suffix speculation (PR 1646). — [ik_llama.cpp README](https://github.com/ikawrakow/ik_llama.cpp)
- The V100 fork's DFlash2 keeps n-max 7. Its tokens per round fall with depth (F16 draft: 3.23 short, 2.51 at 16K, 2.46 at 128K) while round time rises from 21.3 to 26.0 ms. — [llama.cpp-v100 README](https://github.com/1115714829/llama.cpp-v100)

### Inferences
- At long depth every rejected draft token still pays for FA over the full KV in the verify batch. Lowering n-max (for example to 4-5) at depth may raise net tok/s on Volta's slow FA. This should be A/B-tested per depth band, since the fork data show accepted length shrinking with depth.
- MTP is not usable with the current 2-slot layout upstream unless `-np > 1` support has landed since May. Check the current PR state before testing.
- N-gram or suffix speculation is cheap and fits code-editing workloads with repetitive output, but it is only in ik or newer upstream, and ik is the weak option on Volta.

### Gaps
- I did not confirm whether upstream MTP gained multi-slot support between May and October 2026.
- I found no V100 measurement comparing MTP vs DFlash2 on Qwen3.8-27B.
- I found no data on DFlash2 n-max tuning by depth.
