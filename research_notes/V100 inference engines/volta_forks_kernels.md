# Volta (sm_70) forks, ports and kernels for modern LLM inference (as of 2026-10-10)

Context for the reader: the user runs Qwen3.8-27B (hybrid Gated DeltaNet + full attention), GSQ-RCO IQ3_S GGUF with a DFlash2 drafter, on llama.cpp CUDA (FORCE_MMQ), on IBM AC922 nodes: 2x V100-SXM2-16GB with NVLink, **ppc64le, RHEL 7.6**. Baseline 72-86 tok/s decode short ctx, ~33 tok/s at 64-110k, prefill 430-650 tok/s. The platform constraint (ppc64le + RHEL 7.6 glibc) turns out to dominate everything below.

## Which forks exist, are they maintained in 2026, and what speedups do they claim on V100?

### Takeaway
The Volta ecosystem has consolidated onto one project, **1CatAI/1Cat-vLLM** (being renamed 1Cat-LLM): very active (release v1.5.1 on 2026-10-03, ~1.3k stars), it ships Flash-V100 attention, SM70 TurboMind W4A16 kernels, an SM70 FlashQLA/GDN kernel, Qwen3.8-27B + DFlash2 support, and even GGUF IQ3_S adapters. Its headline Qwen3.8-27B numbers (171-229 tok/s single request at 4K-128K with DFlash2) are 2-5x the user's baseline, but they are on **4x V100-32GB TP4** with NVFP4/FP8 weights, and the release wheel is **x86_64-only, glibc >= 2.38, CUDA 12.8, PyTorch 2.10** -- none of which exist for ppc64le RHEL 7.6. Other forks are archived, unmaintained, or point to 1Cat.

### Cited Findings

**1CatAI/1Cat-vLLM (primary, active)**
- Self-description: "V100 / SM70-focused vLLM engineering fork for modern LLM inference"; 1.3k stars, 249 forks, Apache-2.0; latest release v1.5.1 on 2026-10-03, main head merged through 2026-10-05; 89 open issues / 71 open PRs — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Star count was reported as 683 in an article dated 2026-09-01, so it roughly doubled in a month (fast-moving, high community interest) — [smzdm](https://post.smzdm.com/p/aomx3vqm/); [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Supported models include Qwen3.6-27B-AWQ (MTP4), Qwen3.8-27B-NVFP4, Qwen3.8-27B-FP8, Qwen3.8 Flash-Next-NVFP4, DFlash2 drafts for Qwen3.8 (official drafter `incoai/Qwen3.8-27B-DFlash2`), DeepSeek-V4-Flash, GLM-5.3-Flash — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- Quant formats: AWQ/W4A16, Quark W4A16 INT4/UINT4, TurboMind SM70 kernels, compressed-tensors, ModelOpt NVFP4, MXFP4, QPN8/4/2, FP8 E4M3/E5M2 KV cache, and GGUF (IQ3_S, IQ4_XS, IQ3_XXS operators) — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Qwen3.8-27B V100 numbers (4x V100-SXM2-32GB, TP4): NVFP4 no-MTP 61.8 / 50.4 tok/s at 128K / 256K; FP8 50.7 / 41.1 tok/s at 128K / 256K; v1.5.1 release single request 229.3 / 201.2 / 171.4 tok/s at 4K / 32K / 128K; C4 aggregate 445.5 tok/s at 32K; NVFP4+DFlash2 206 / 252 / 316 tok/s on streaming / MBPP / lookup contracts; ~260 tok/s demo headline. README warns the figures come from different "contracts" and are not directly comparable — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- The ~260 tok/s headline was a 4x V100 **16GB** demo with Qwen3.8-27B-NVFP4 + DFlash2; README says it is "not a universal fixed decode rate". No TP2 or 16GB-specific numbers; PR #666 has only "bounded capability checks" at TP1 64K and TP2 256K on 32GB cards — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- **GGUF IQ3_S path, directly relevant:** a development composition "Flash-Next GSQ-RCO IQ3_S + FP16 MTP4, 4x V100-SXM2-32GB, TP4" reports 92.267 tok/s decode at C1 and 280.441 aggregate at C4. GGUF support postdates the v1.5.1 wheel (source/dev build only), and the README states "Adapter support, kernel admission and model-quality qualification are separate milestones". Native adapters: Qwen3.5 dense, Qwen3.5 MoE, Qwen4Exp/Flash-Next, DFlash2 drafts — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- Platform requirements: Linux **x86_64**, GLIBC >= 2.38, Python 3.12, PyTorch 2.10.0 + CUDA 12.8 runtime, CUDA 12.8 toolkit + ninja for TileLang JIT, driver >= 570.124.06 recommended (tested 580.173.02); wheel has not passed the manylinux gate; ppc64le not mentioned — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- No performance comparison with llama.cpp in the README — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Third-party measurement (Cloudrift emmy PR #733, merged 2026-09-07), 8x V100-SXM2-**16GB**, **no NVLink**, 1Cat-vLLM fork build, 1000 in / 1000 out, concurrency 4: Qwen3.8-27B-GPTQ-Int4 TP2 40.21 output tok/s aggregate (median TPOT 96.76 ms, TTFT 2,884 ms, 64K ctx); FP8 TP4 32.46 tok/s (TPOT 100.98 ms); FP16 TP8 19.62 tok/s. A near-full-window prompt did not finish prefill within 20 minutes — [GitHub PR #733](https://github.com/cloudrift-ai/emmy/pull/733)
- Same PR: the Volta GDN kernel `flash_qla_sm70_gdn_strided` failed to JIT (`cusparse.h` missing), needing `VLLM_SM70_GDN_DECODE_FLASHQLA=0`; the 1.0.0 image also lacked `partial_rotary_factor` and `output_gate_type: "swish"` support for Qwen3.8, which "would have caused silent numerical errors rather than a crash" — [GitHub PR #733](https://github.com/cloudrift-ai/emmy/pull/733)
- Chinese community report (2026-08-31/09-01): 2x V100S-32GB, 1Cat-vLLM, Qwen3.8-27B FP8, 256K ctx: 59.3 tok/s single stream, 220 tok/s at concurrency; same server llama.cpp Q6_K single card 12.18 tok/s, dual card with MTP 46 tok/s; a Bilibili creator reported up to 280 tok/s with Qwen3.8-27B NVFP4 on 4x V100 NVLink with 1Cat-vLLM 1.5.0 — [smzdm](https://post.smzdm.com/p/aomx3vqm/)
- A dual V100-16GB user (2026-06-26) tried 1Cat-vLLM per its docs and hit OOM, then ran Qwen3.6-35B-A3B on llama.cpp (Q4_K_M, 256K, `-np 2`) at ~100 tok/s peak, 70+ average — [Juejin](https://juejin.cn/post/7655376386387984399)

**humanjesse/vllm-v100 (derivative of 1Cat)**
- Extends 1Cat-vLLM with compressed-tensors, MoE and kernel accuracy fixes, GGUF (Q3_K_M, Q4_K_M, Q6_K_L, Q8_0) support; pinned stack Python 3.12, CUDA 12.8, PyTorch 2.9.1+cu128, Triton 3.5.1; no dates given; does not mention Qwen3.8 — [GitHub README](https://raw.githubusercontent.com/humanjesse/vllm-v100/main/README.md)
- V100-SXM2-32GB numbers: Qwen3.6-35B-A3B Q8_0 TP2 ~100 tok/s single stream; Granite-4.1-8B AWQ TP2 ~127 tok/s; Mistral-Small-4 119B Q4_K_M TP8 ~82-86 tok/s short prompt but ~24 at 6k prompt — [GitHub README](https://raw.githubusercontent.com/humanjesse/vllm-v100/main/README.md)
- Speculative decoding on Qwen3.6-35B is **net-negative** on V100: ~46 tok/s with flash_attn_v100 (forced to piecewise CUDA graphs) and ~77 with triton_attn vs ~100 without speculation; first-request Triton JIT 30-90 minutes; custom all-reduce unsupported on SM70 — [GitHub README](https://raw.githubusercontent.com/humanjesse/vllm-v100/main/README.md)

**Archived / unmaintained forks**
- jajmangold/vllm-sm70: archived, points users to 1Cat-vLLM — [GitHub](https://github.com/jajmangold/vllm-sm70) (status per search summary)
- dg1kjd/1Cat-vLLM: description says "[Unmaintained, use dg1kjd/sglang-sxm2]", originally "AWQ 4-bit support, CUDA 12.8 build flow, and validated Qwen3.5 27B/35B deployment on multi-GPU V100" — [GitHub](https://github.com/dg1kjd/1Cat-vLLM)
- Many plain mirrors of 1Cat (marioblack356, hamawang, cookys, weizx208, tkuennen) — [GitHub](https://github.com/marioblack356/1Cat-vLLM), [GitHub](https://github.com/tkuennen/1cat-vllm)

**Upstream vLLM**
- A vLLM forum post reports vLLM 0.20.0+ no longer supports sm_70 and suggests <= 0.18.x — [vLLM Forums](https://discuss.vllm.ai/t/support-for-v100-sm-70-on-vllm-0-20/2605); corroborated by a user who downgraded to vLLM 0.18.0 "because vLLM 0.20+ dropped SM70" — [Juejin](https://juejin.cn/post/7655376386387984399)

**qengine (from-scratch CUDA engine for Qwen3.5/3.6 on sm_70)**
- Haru-neo/qengine, Apache-2.0, post dated 2026-05-03; targets sm_70 (CMP 100-210 mining cards, V100, Titan V); Qwen3.5-27B/9B Q8_0 GGUF. Vs llama.cpp build 8462 (`-fa 1`) on the same cards: 27B decode 26.3 vs 17.7 tok/s (+48%); 9B prefill 2.99x at 297 tok down to 1.22x at 18K; 9B dual-GPU at 18K only 0.48x of llama.cpp; no P2P/NVLink support; DFlash speculative decoding broken (~0% accept); solo project — [DEV Community](https://dev.to/haru-neo/i-wrote-a-custom-cuda-inference-engine-to-run-qwen35-27b-on-130-mining-cards-732)

**SGLang**
- The only SGLang Volta fork found is `dg1kjd/sglang-sxm2`, named in the dg1kjd repo description; a search returned nothing for it — [GitHub](https://github.com/dg1kjd/1Cat-vLLM)

### Inferences
- On 4x V100-32GB x86 boxes, 1Cat-vLLM with NVFP4/FP8 + DFlash2 clearly beats llama.cpp. The README's single-request numbers (171 tok/s at 128K vs the user's ~33 tok/s at 64-110k) would be a >5x long-context decode gain **if** they transferred. They probably won't transfer cleanly to 2x16GB: the user has half the GPUs and half the memory per GPU (64 GB total vs 128 GB). Qwen3.8-27B NVFP4 (~14-15 GB?) or GPTQ-Int4 (19.6 GB per PR #733) would fit at TP2 on 2x16GB only with tight KV budgets, and a 1Cat user has already OOMed on dual 16GB. The weight sizes for NVFP4 are my estimate, not a sourced figure.
- The third-party 16GB/no-NVLink numbers (PR #733: ~97 ms TPOT, i.e. ~10 tok/s per stream at C4, GPTQ-Int4 TP2) are well **below** the user's llama.cpp baseline. The lack of NVLink is a confound, and the user does have NVLink.
- **Blocking constraint:** 1Cat needs CUDA 12.8, PyTorch 2.10 and glibc >= 2.38 on x86_64. Search results indicate NVIDIA ended ppc64le support after CUDA 12.4.x, and only on RHEL 8 by then. Container images for CentOS/UBI 7 stopped at 12.4.0 ([NVIDIA forums](https://forums.developer.nvidia.com/t/missing-cuda-drivers-for-ppc64le-on-rhel9/301323), per search summary). RHEL 7.6 ships glibc 2.17. Running 1Cat on the AC922s would therefore mean porting the engine (PyTorch 2.10, Triton, TileLang JIT) to ppc64le with CUDA <= 12.4. That looks impractical; it is not "install a fork". The realistic route to these gains is porting individual **kernels** (Flash-V100 attention, the GDN kernel, QPN/m8n8k4 decode GEMV) into llama.cpp, which already runs on the cluster.
- 1Cat's GGUF IQ3_S path (GSQ-RCO IQ3_S on Flash-Next) shows the same quant family the user already serves can run in 1Cat. The dense Qwen3.8-27B GGUF + DFlash2 adapter combination is listed with "loading and generation checks" only, not throughput.

### Gaps
- Exact last-commit dates and star counts for jajmangold/vllm-sm70, dg1kjd forks and humanjesse/vllm-v100 could not be retrieved (the GitHub page fetch returned 503 for one).
- dg1kjd/sglang-sxm2 could not be found or verified.
- No source found for any of these engines running on ppc64le/POWER9.
- No apples-to-apples benchmark of 1Cat vs llama.cpp on the same 2x V100-16GB NVLink box with Qwen3.8-27B.

## Is there a FlashAttention-equivalent for Volta that materially speeds long-context (64-128k) decode/prefill?

### Takeaway
Yes for **prefill**, inside 1Cat-vLLM. Its Flash-V100 kernel is a Volta-specific rewrite reaching ~70 TFLOP/s causal attention on one V100, up from 17.9, and it underpins 5-6k tok/s long-context prefill there. Standalone ports (sirCamp, ZRayZzz, ai-bond) are prefill/training-oriented with no decode path. For llama.cpp, a Volta FA port exists only in forks: one reports up to +39.9% prefill at unspecified contexts and **no decode gain**. Mainline llama.cpp's Volta FA path is unoptimized (it reuses the Ampere MMA config) and the analysis issue is open and stale.

### Cited Findings
- 1Cat Flash-V100 is "rebuilt for Volta, not a direct port": it emulates `cp.async`/`ldmatrix` with LDG/STS, register prefetch, double buffering and swizzled smem; uses D256 Split-D, N32 online softmax, K-stage ping-pong, Split-KV3, 6-head GQA packing and FP32 QK/PV accumulation. Causal attention throughput on one V100 went 17.92 -> 46.6-47.1 -> ~60.8 -> 69.98-71.11 TFLOP/s; ~79 TFLOP/s is an experimental ceiling — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- 1Cat full-model prefill: NVFP4 MoE 6,507 / 6,241 / 5,871 tok/s at 32K / 64K / 131K (PR #390); DFlash2 NVFP4 prefill 4,069 / 3,567 tok/s at 32K / 64K (PR #417); QSA prefill +32% at 32K-131K (PR #387). These are 4x V100 numbers, the first set for an MoE model — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- PR #785 lets Flash-V100 be built for SM72 when requested, keeping SM70 as the default — [GitHub PR #785](https://github.com/1CatAI/1Cat-vLLM/pull/785)
- In vllm-v100, `FLASH_ATTN_V100` needs the `flash_attn_v100` wheel and silently falls back to Triton without it — [GitHub README](https://raw.githubusercontent.com/humanjesse/vllm-v100/main/README.md)
- llama.cpp issue #28037 (opened 2026-08-30, still open, no maintainer replies, marked stale 09-30 and un-staled 10-04): the Volta branch `ggml_cuda_fattn_mma_get_config_volta()` falls back to the Ampere config; Volta MMA is m8n8k4 without ldmatrix/cp.async. Tuning on a Jetson Xavier (SM72) with Qwen3.6-35B-A3B gave 20.85 vs 19.68 tok/s decode (a ~5% regression). The author attributes the ~2x gap vs Turing/Ampere to hardware. Proposals: a split-D WMMA kernel (estimated, not measured, ~35%), MTP and persistent blocks — [GitHub issue #28037](https://github.com/ggml-org/llama.cpp/issues/28037)
- Same issue: fork commits "cuda: Volta (sm_70) D256 split-D prefill FlashAttention" (Encoded404, 2026-09-24); a comment (2026-10-03) says 1Cat's FLASH_ATTN_V100 was ported to a llama.cpp fork (fishlikeX/sm70-attn), with "no decode gain and up to 39.9% prefill gain at specific contexts". This is unverified, the contexts are unnamed, and the repo was not findable by search — [GitHub issue #28037](https://github.com/ggml-org/llama.cpp/issues/28037)
- sirCamp/flash-attention-legacy: FA2 for Pascal/Volta via WMMA 16x16x16, FP16 only, head dims 64 and 128 only, fwd+bwd, varlen; "decode (q_len=1) falls back to standard attention"; 26 stars; benchmarks only 1.08-1.14x vs SDPA on embedding models; integrates with HF Transformers only — [GitHub](https://github.com/sirCamp/flash-attention-legacy)
- ZRayZzz/flash-attention-v100 (an early CUTLASS-based FA2-style V100 port), ai-bond/flash-attention-v100 (maintained for V100/T4 ComfyUI use) and FearL0rd/ComfyUI-Flash-Attention_v100 exist; maintenance not verified — [ollama issue #10859](https://github.com/ollama/ollama/issues/10859); [GitHub](https://github.com/FearL0rd/ComfyUI-Flash-Attention_v100)
- ik_llama.cpp has a "Research: V100 Flash Attention Implementation" issue #463 — [GitHub](https://github.com/ikawrakow/ik_llama.cpp/issues/463)

### Inferences
- Qwen3.8 full-attention layers use head dim 256: 1Cat's work is "D256 Split-D", and the Xavier analysis uses Qwen3.6 D=256. sirCamp's port supports only d=64/128, so it is irrelevant for this model.
- For the user's long-context **decode** collapse (86 -> 33 tok/s), no Volta FA port has demonstrated a llama.cpp decode gain. 1Cat's long-context decode advantage likely comes from the whole stack (TP4 bandwidth, NVFP4/FP8 weights, FP8 KV, CUDA graphs, GDN kernels), not attention alone. This is speculation.
- Long-context **prefill** is where a Volta FA kernel plausibly helps llama.cpp (+30-40% reported), which would raise the user's 430-650 tok/s prefill.

### Gaps
- No measured llama.cpp + Volta-FA numbers at 64-128K on V100 from a primary source.
- xformers and FlashInfer sm70 status: no sources found in this pass.

## Which quantized matmul kernels exploit Volta tensor cores for 3-4 bit weights?

### Takeaway
The candidates are LMDeploy TurboMind W4A16 (officially lists sm70), 1Cat's bundled SM70 TurboMind kernels plus its QPN "quadpair-N" decode GEMV built on the m8n8k4 layout (from "v100-skinny"), and 1Cat's GGUF IQ3_S/IQ4_XS/IQ3_XXS operators. No Marlin port for sm70 was found; vllm-v100 explicitly says not to use `gptq_marlin`. No published V100 microbenchmark compared any of these with llama.cpp MMQ for IQ3_S.

### Cited Findings
- LMDeploy docs (stable/latest/v0.6.0) list V100 (sm70) as supported for TurboMind AWQ/GPTQ INT4 W4A16; v0.2.0/v0.3.0 docs listed only sm75+ — [LMDeploy docs](https://lmdeploy.readthedocs.io/en/stable/quantization/w4a16.html); [v0.3.0 docs](https://lmdeploy.readthedocs.io/en/v0.3.0/quantization/w4a16.html)
- 1Cat lists "TurboMind SM70 kernels", "exact-shape decode GEMV", and grouped TurboMind MoE for W4A16_NVFP4 experts (PR #270). The m8n8k4 reference appears in the acknowledgements, for the QPN2/QPN4/QPN8 "quadpair-N" decode layout from v100-skinny — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- 1Cat GGUF operators: IQ3_S, IQ4_XS and IQ3_XXS gate/up pairs can share activations; PR #966 adds seven IQ3_XXS/IQ3_S mixed pairs; Q4_K (PR #968) is storage only, with no accelerated route — [GitHub README](https://raw.githubusercontent.com/1CatAI/1Cat-vLLM/main/README.md)
- vllm-v100: "Don't use `--quantization gptq_marlin`" on V100; uses compressed-tensors/AWQ/auto-round W4A16 — [GitHub README](https://raw.githubusercontent.com/humanjesse/vllm-v100/main/README.md)

### Inferences
- NVFP4 "support" on V100 cannot be native (V100 has no FP4/FP8 tensor cores). It must be dequant-to-FP16 weight-only kernels, so it behaves like W4A16 in bandwidth terms. This is an inference, not stated in the sources.
- Decode at batch 1 is memory-bandwidth-bound. IQ3_S (~3.4 bpw) already moves fewer bytes than 4-bit W4A16 or NVFP4, so a W4A16 kernel alone should not beat llama.cpp's IQ3_S decode per GPU. The gains seen in 1Cat come from TP across more GPUs, speculative decoding and graph capture.

### Gaps
- No Volta-specific Marlin port found. No standalone sm70 W3/W4 GEMM benchmark vs llama.cpp MMQ found. The "v100-skinny" project referenced by 1Cat was not located.

## Linear-attention / Gated DeltaNet kernels on sm70

### Takeaway
Volta GDN kernels exist but are immature. weicj/FlashQLA-SM70-SM75 is forward-only, has been runtime-validated only on SM75, and only compiles for SM70. 1Cat bundles an sm70 FlashQLA GDN kernel that a third party could not JIT in a stock image. ComfyUI disabled its fused DeltaNet kernels below SM75 after V100 launch failures. Even on SM75, the GDN-stage 2x speedup moved whole-request decode by only +0.6%.

### Cited Findings
- FlashQLA-SM70-SM75: experimental fork of QwenLM/FlashQLA with `chunk_gated_delta_rule_fwd_legacy`; 13 stars, 21 commits; SM70 "compile check passes. Runtime validation is pending"; on SM75 a 2.1x GDN-stage speedup but whole request prefill +7.17%, decode +0.61% — [GitHub](https://github.com/weicj/FlashQLA-SM70-SM75)
- 1Cat's `flash_qla_sm70_gdn_strided` failed to JIT without `cusparse.h`; workaround `VLLM_SM70_GDN_DECODE_FLASHQLA=0` — [GitHub PR #733](https://github.com/cloudrift-ai/emmy/pull/733)
- comfy-kitchen: `gated_delta.is_available()` returned True on V100, then `deltanet_conv_step` raised "launch rejected"; the fix declines fused DeltaNet kernels below SM75 — [GitHub issue #210](https://github.com/Comfy-Org/comfy-kitchen/issues/210); [PR #211](https://github.com/Comfy-Org/comfy-kitchen/pull/211)

### Inferences
- GDN is not the long-context bottleneck: its state is constant-size, so the decode slowdown at depth comes from the full-attention layers' KV reads. A V100 GDN kernel is unlikely to fix the 64-110k drop, consistent with the +0.6% decode result.

### Gaps
- No V100 runtime benchmark of any GDN kernel.

## Are there V100-specific benchmarks comparing these against llama.cpp?

### Takeaway
Only anecdotal or mismatched ones. Chinese community numbers on the same 2x V100S-32GB box: 1Cat-vLLM FP8 at 59.3 tok/s vs llama.cpp dual-card MTP at 46 tok/s. qengine on throttled mining Volta: 27B decode +48% vs llama.cpp. No controlled comparison exists for Qwen3.8-27B IQ3_S + DFlash2 on 2x V100-16GB NVLink, and notably the user's llama.cpp baseline (72-86 tok/s) is already above most published V100 llama.cpp numbers.

### Cited Findings
- 2x V100S-32GB: 1Cat-vLLM Qwen3.8-27B FP8 59.3 tok/s single stream / 220 at concurrency; llama.cpp Q6_K single card 12.18 tok/s; llama.cpp dual card + MTP 46 tok/s — [smzdm](https://post.smzdm.com/p/aomx3vqm/)
- Single V100 llama.cpp Qwen3.6-27B: ~15 tok/s (16GB, IQ4_XS, Bilibili); ~30 tok/s falling with context (32GB, Zhihu); MTP branch 29-30 -> 54-55 tok/s, dropping to 40-45 at long context (32GB SXM) — [Bilibili](https://www.bilibili.com/video/BV1nfL26VEmG/); [Zhihu](https://zhuanlan.zhihu.com/p/2041199273103057665); [Zhihu](https://zhuanlan.zhihu.com/p/2035658835495482038) (as summarised by search; not fetched individually)
- qengine vs llama.cpp (sm_70 CMP 100-210, no NVLink): 27B Q8_0 decode 26.3 vs 17.7 tok/s — [DEV Community](https://dev.to/haru-neo/i-wrote-a-custom-cuda-inference-engine-to-run-qwen35-27b-on-130-mining-cards-732)

### Inferences
- The most credible "significant improvement" path is 1Cat-vLLM. It is blocked by ppc64le/RHEL 7.6/CUDA 12.8, and it is not proven on 2x16GB. The practical takeaway for this cluster is to track the llama.cpp Volta FA forks (prefill gains) and 1Cat's kernel ideas (FP8 KV, QPN decode GEMV) for porting, rather than to switch engines.

### Gaps
- No controlled same-hardware comparison; all cross-engine numbers mix quant, GPU count, NVLink presence and speculative settings.
