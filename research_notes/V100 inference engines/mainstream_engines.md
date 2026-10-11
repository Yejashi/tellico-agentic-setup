# Volta/V100 (sm_70) support of mainstream GPU LLM serving engines (as of 2026-10-10)

Context: Qwen3.8-27B (hybrid Gated-DeltaNet + full attention) on IBM AC922 (ppc64le, RHEL 7.6), 2x V100-SXM2-16GB with NVLink per node. Baseline is llama.cpp with IQ3_S plus a DFlash2 drafter: 72-86 tok/s single, 52-70 each with two concurrent, about 33 tok/s at 64-110k depth, prefill 430-650 tok/s.

Research budget note: about 15 tool calls were used. MLC-LLM, Aphrodite, KTransformers, Candle, mistral.rs and ExLlamaV2 got no dedicated primary-source verification and are listed under Gaps. Two items from search engines whose pages were not opened and read are marked "(search snippet only)".

## Which engines actually run on V100 today with fp16 and a 3-4 bit quant fitting in 2x16 GB with long context?

### Takeaway
Upstream vLLM, SGLang and TensorRT-LLM have all left sm_70 behind: vLLM requires CC 7.5, SGLang's default FlashInfer needs sm75 and SGLang now requires CUDA 13, and TRT-LLM does not list Volta. The only engines that still claim V100 are LMDeploy/TurboMind and a community fork, 1Cat-vLLM. 1Cat-vLLM is clearly the most serious contender. It ships x86_64-only wheels needing GLIBC 2.38 and is tuned for 4x V100 32GB, so on 2x16 GB ppc64le RHEL 7.6 it is an unproven, source-build-only proposition.

### Cited Findings
**vLLM (upstream)**
- Current vLLM docs: CUDA GPUs need "compute capability 7.5 or higher (e.g., T4, RTX20xx, A100...)". Default binaries are built with CUDA 12.9, with 12.8 and 13.0 builds also offered. Only x86_64 and aarch64 are mentioned, no ppc64le — [vLLM GPU install docs](https://docs.vllm.ai/en/latest/getting_started/installation/gpu/)
- vLLM forum, 2026-04-30: vLLM 0.20.0 fails to install on V100. The reply says 0.20.0+ dropped sm_70 from build targets, that ≤0.18.x still include it, and that a cu126 build also failed. This is an automated RunLLM reply, not an official changelog, so the exact version boundary is unverified — [discuss.vllm.ai](https://discuss.vllm.ai/t/support-for-v100-sm-70-on-vllm-0-20/2605)
- The older vLLM quantization table (v0.10.1, 2025) for Volta lists GPTQ, BitBLAS(GPTQ), bitsandbytes, DeepSpeedFP and GGUF as supported. AWQ, Marlin (GPTQ/AWQ/FP8), INT8 W8A8 and FP8 W8A8 are not supported on Volta — [vLLM v0.10.1 supported hardware](https://docs.vllm.ai/en/v0.10.1/features/quantization/supported_hardware.html)
- Upstream toolchain: PyTorch 2.15 stops publishing CUDA 12.6 wheels and drops Maxwell/Pascal/Volta, so 2.14 is the last with sm_70 wheels — [PyTorch dev-discuss notice](https://dev-discuss.pytorch.org/t/notice-cuda-12-6-wheels-will-no-longer-be-published-from-pytorch-2-15-drops-maxwell-pascal-volta/3432) (search snippet only)
- CUDA 13 removed Volta offline compilation. CUDA 13 artefacts fail on V100 while CUDA 12 images work — [Jungfraujoch commit](https://gitea.psi.ch/mx/Jungfraujoch/commit/4e6600a96c8e762f678f37a8f951b6614addd663?files=docs), [LocalAI issue 9948](https://github.com/mudler/LocalAI/issues/9948)
- A CUDA.jl error reads "Tesla V100-PCIE-32GB ... not supported on CUDA 13+ ... use a device with at least capability 7.5, or downgrade your NVIDIA driver to below v580" — [CUDA.jl issue 3079](https://github.com/JuliaGPU/CUDA.jl/issues/3079)

**1Cat-vLLM (community fork, the strongest V100 option)**
- It is a V100/SM70-focused vLLM fork ("becoming 1Cat-LLM"). The latest release is v1.5.1 (2026-10-03), and the README covers main through 2026-10-05 — [GitHub 1CatAI/1Cat-vLLM](https://github.com/1CatAI/1Cat-vLLM)
- It explicitly supports Qwen3.8-27B (NVFP4 QAT target, FP8, and the DFlash2 drafter `incoai/Qwen3.8-27B-DFlash2`), Qwen3.6-27B-AWQ with MTP4, Qwen3.6-35B-A3B NVFP4, and Qwen3.5 through GGUF adapters only. It has GDN (Gated DeltaNet) handling ("FlashQLA/GDN, GDN metadata, mixed-precision GDN routing") and hybrid Mamba-state handling — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Quantization formats are AWQ/W4A16, ModelOpt NVFP4, MXFP4, compressed-tensors, Quark W4A16, and QPN2/4/8. GGUF operators cover IQ3_XXS, **IQ3_S** and IQ4_XS, with Q4_K "prepared, no accelerated route yet". GPTQ is not mentioned. KV cache is FP8 E4M3 (the default) or E5M2 — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Attention is a FlashAttention-V100 rebuilt for Volta, using software async loads instead of `cp.async`, with D256 kernels and split-KV. Causal attention reached about 60.8 TFLOP/s, and the DFlash2 draft attention uses FLASH_ATTN_V100 — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Parallelism: TP4 is the main release configuration. **TP1/TP2 are "bounded capability checks"** (PR #666). TP8 and PP2xTP4 are used for large models, with a custom TP4 all-reduce — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Requirements: the wheel `cp312 linux_x86_64` needs GLIBC ≥ 2.38, PyTorch 2.10 with CUDA 12.8, and CUDA Toolkit 12.8. Source builds use `TORCH_CUDA_ARCH_LIST=7.0`. Driver 570.124.06 or newer is recommended — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Benchmarks on **4x V100-SXM2-32GB, TP4**, single request, 27B NVFP4 + DFlash2: 229 tok/s at 4K, 201 tok/s at 32K, 171 tok/s at 128K input. Aggregate is 445 tok/s at 32K with C4 and 625 tok/s with C8. Without speculation, NVFP4 decodes at 61.8 tok/s at 128K and FP8 at 50.7 tok/s at 128K. Qwen3.6-27B-AWQ + MTP4 runs 100.6 tok/s at 64K and 85.3 at 128K. 32K prefill is about 4,069 tok/s. The demo headline claims about 260 tok/s on 4x V100 **16GB** — [GitHub](https://github.com/1CatAI/1Cat-vLLM)
- Third-party summaries: 2x V100 32GB is supported for selected 27B profiles with max_num_seqs=1. A Docker Hub example runs Qwen3.8-27B-FP8 at TP2 with `VLLM_SM70_FP8_TURBOMIND=1`. A Reddit post benchmarks Qwen3.8-27B on 2 NVLinked V100 SXM2 **32GB** cards, but the page could not be fetched (HTTP 502) — [Docker Hub sssssks/1cat-vllm](https://hub.docker.com/r/sssssks/1cat-vllm), [r/LocalLLM via redlib](https://redlib.groet-infra.nl/r/LocalLLM/s/4w8CIf9Q38) (search snippet only)

**SGLang**
- FlashInfer, the default attention backend, "only supports sm75 and above". The fallback `--attention-backend triton --sampling-backend pytorch` is documented only for sm75+ devices. SGLang now requires CUDA 13: cu129 wheels were retired with the PyTorch 2.14 upgrade, and 0.5.19 / `lmsysorg/sglang:v0.5.19-cu129` is the last CUDA 12 release — [SGLang install docs](https://docs.sglang.io/get_started/install.html)

**TensorRT-LLM**
- The support matrix lists GB200, Blackwell, Grace Hopper, Hopper, Ada and Ampere. Volta is not listed, and unlisted architectures are "community support" only. INT4 AWQ/GPTQ with FP8 activations requires SM ≥ 89 — [TRT-LLM support matrix](https://nvidia.github.io/TensorRT-LLM/reference/support-matrix.html)

**LMDeploy / TurboMind**
- The install docs list "Volta(sm70): V100" among supported NVIDIA GPUs. The README says TurboMind supports MXFP4 from V100 onward and that Qwen3.5 support was added in Feb 2026 — [LMDeploy README](https://raw.githubusercontent.com/InternLM/lmdeploy/main/README.md) (search snippet only)
- Supported-models table: **TurboMind** has Qwen3 and Qwen3.5 (0.8B-397B, FP16/BF16, KV INT8 yes, KV INT4 no, W4A16 yes), with "TurboMind does not currently support the vision encoder for the Qwen3.5 series". **PyTorchEngine** has Qwen3-Next 80B and Qwen3.5 in FP16/BF16 only, with no KV quant and no W4A16. Qwen3.6 and Qwen3.8 are not listed. The page says nothing specific to sm70 — [LMDeploy supported models](https://lmdeploy.readthedocs.io/en/latest/_sources/supported_models/supported_models.md)

**TGI**
- TGI is in maintenance mode, and the docs recommend vLLM, SGLang or llama.cpp instead — [TGI docs](https://huggingface.co/docs/text-generation-inference/index)

### Inferences
- Memory arithmetic: Qwen3.8-27B in FP8 (~26 GB) leaves almost nothing for KV on 2x16 GB, and NVFP4 at about 24.6 GiB including KV per the [orcarouter guide](https://www.orcarouter.ai/ja/blog/qwen-3-8-27b-vllm) is also very tight. A 1Cat-vLLM AWQ/W4A16 checkpoint (~14-15 GB) or its GGUF IQ3_S route are the plausible fits on a 2x16 GB node. Neither has published numbers at TP2/16GB.
- **ppc64le/RHEL 7.6 is likely the binding constraint, more than sm_70.** RHEL 7.6 ships glibc 2.17. 1Cat's wheel is x86_64 and needs glibc ≥ 2.38, and PyTorch/Triton/TileLang ppc64le wheels for recent versions are not published. Any vLLM-family engine would need a from-source build of PyTorch 2.10, Triton, TileLang and the fork on ppc64le, or a container with a newer userland, if the cluster permits one. This is inference; I did not verify ppc64le availability.
- Per-node expectation if 1Cat could be built at TP2: its TP4 numbers come from four GPUs with twice the bandwidth, so naive halving gives roughly 100-115 tok/s single-stream with DFlash2 at 4-32K. That would be a meaningful gain over 72-86, and its 128K behaviour (171 tok/s at TP4) suggests far better long-context decode than llama.cpp's 33 tok/s. This is speculative extrapolation, and the fork itself calls TP2 only a "bounded capability check".
- LMDeploy/TurboMind runs on V100 but does not list Qwen3.8. Its Qwen3-Next support is PyTorchEngine-only (Triton) and fp16 with no 4-bit, which would not fit 27B weights plus 128K KV in 32 GB anyway.

### Gaps
- No primary 2x V100 16GB benchmark of any non-llama.cpp engine for Qwen3.8-27B was found.
- The exact vLLM version that removed sm_70 (0.19 vs 0.20) is not confirmed by official release notes.
- Whether CUDA 12.8 still supports RHEL 7 / ppc64le hosts was not checked. This matters for 1Cat's CUDA 12.8 requirement.

## Do the hybrid Gated DeltaNet / linear attention kernels (flash-linear-attention, Triton) work on sm_70?

### Takeaway
No primary source confirms or denies that fla's Gated DeltaNet Triton kernels run on sm_70. Triton nominally supports CC 7.0+. 1Cat-vLLM has GDN running on V100 in production configurations, which is the strongest existence proof, though it may use its own kernels ("FlashQLA/GDN") rather than stock fla.

### Cited Findings
- fla is a Triton-based PyTorch library with Gated DeltaNet added Dec 2024. One listing gives its requirements as PyTorch ≥ 2.5 and Triton ≥ 3.0. No compute-capability statement was found — [jimmysong.io fla page](https://jimmysong.io/en/ai/flash-linear-attention)
- The Triton README lists "NVIDIA GPUs (Compute Capability 7.0+)". This was seen in a fork's README, not the upstream repo — [triton fork README](https://github.com/bmyerz0/triton/blob/main/README.md) (search snippet only)
- No fla-org issue mentioning V100/sm_70 was found. The closest, #196, is a Triton 3.2 failure on H800 — [fla issue 196](https://github.com/fla-org/flash-linear-attention/issues/196)
- 1Cat-vLLM runs Qwen3.8-27B, Qwen3.6-27B and Qwen3.6-35B-A3B on V100 with "FlashQLA/GDN" and "mixed-precision GDN routing" — [GitHub 1Cat-vLLM](https://github.com/1CatAI/1Cat-vLLM)
- ExLlamaV3 vendors fla's chunked linear-attention prefill kernels under `exllamav3/vendor/fla` — [exllamav3 GitHub](https://github.com/turboderp-org/exllamav3)
- The official flash-attn package supports only SM 8.0+, so Volta users need forks such as flash-attention-legacy — [sirCamp/flash-attention-legacy](https://github.com/sirCamp/flash-attention-legacy)

### Inferences
- fla's kernels use bf16/fp32 and `tl.dot`. On sm_70 Triton can lower fp16 dots to Volta MMA, but bf16 paths would fall back or fail, so fp16 dtype selection likely matters. This is unverified.
- llama.cpp's own CUDA GDN ops already work on the user's V100s (the baseline runs), so the hybrid architecture itself is not a V100 blocker.

### Gaps
- No direct test or issue report of fla `chunk_gated_delta_rule` on V100 was found.

## Is ExLlamaV2/V3 viable on Volta, and does ExLlamaV3 support Qwen3-Next-style models?

### Takeaway
ExLlamaV3 supports the architectures: Qwen3-Next, Qwen3.5 and "Qwen 3.8-Flash-Next" are listed, along with TP, speculative decoding and DFlash. Volta support is undocumented. It targets "modern consumer-class GPUs", and its kernel work is Ampere-focused.

### Cited Findings
- ExLlamaV3 lists `Qwen3NextForCausalLM`, `Qwen3_5ForConditionalGeneration`, `Qwen3_5MoeForConditionalGeneration` and "Qwen 3.8-Flash-Next" (`Qwen4ExpForConditionalGeneration`). Qwen3.6 and dense Qwen3.8-27B are not named. It has tensor- and expert-parallel inference and speculative decoding. It requires CUDA ≥ 12.4 and PyTorch ≥ 2.6, and states no compute-capability floor — [exllamav3 GitHub](https://github.com/turboderp-org/exllamav3)
- The v1.0.0 notes (mirrored) say it removed the flash-attention-2 and xformers dependencies, added a new attention kernel and INT8 GEMV, and "greatly improved GEMM/GEMV performance on Ampere" — [scrapbox ExLlamaV3](https://scrapbox.io/work4ai/ExLlamaV3)
- r/LocalLLaMA (May 2026) reports DFlash speedups of about 1.3-3x on consumer GPUs, with per-GPU numbers for 3090/4090/5090/RTX 6000 Pro and none for V100 — [reddit snapshot](https://reddit.sentinel-team.org/posts/1t9voxs/snapshots/2026-05-15T23%3A40%3A01.25497Z)

### Inferences
- Removing the flash-attn-2 dependency removes the main historical sm80 blocker, so a Volta build is not ruled out. ExLlamaV3's EXL3 (QTIP-style trellis) kernels, however, are heavily tuned for Ampere+ tensor-core instructions, and no V100 user reports were found. Treat it as untested.
- ExLlamaV2 historically ran on Volta/Pascal in fp16, but it does not support Qwen3-Next/3.5-style GDN (not verified this session), so it is not an option for Qwen3.8.

### Gaps
- No V100 reports for ExLlamaV3, and no current ExLlamaV2 architecture list, were checked.

## LMDeploy TurboMind: still sm70, and does it support Qwen3.5/3.6/3.8 hybrids?

### Takeaway
Volta is still listed as supported. TurboMind lists Qwen3.5 (text, W4A16, KV INT8). Qwen3.6 and Qwen3.8 are not listed, and Qwen3-Next is PyTorchEngine-only in fp16. Qwen3.8-27B support is plausible only if it shares the Qwen3.5 architecture class, and that is unverified.

### Cited Findings
- See the LMDeploy findings in the first section — [LMDeploy supported models](https://lmdeploy.readthedocs.io/en/latest/_sources/supported_models/supported_models.md), [LMDeploy README](https://raw.githubusercontent.com/InternLM/lmdeploy/main/README.md)
- Interestingly, 1Cat-vLLM has a `VLLM_SM70_FP8_TURBOMIND=1` path, which suggests it borrows TurboMind-style FP8 kernels for sm70 — [Docker Hub sssssks/1cat-vllm](https://hub.docker.com/r/sssssks/1cat-vllm) (search snippet only)

### Gaps
- No V100 TurboMind benchmarks for Qwen3.5 were found, and it is unverified whether TurboMind's W4A16 (AWQ) kernels still build for sm70 in current releases.

## Real-world V100 tok/s numbers and tensor-parallel gains on NVLink V100 pairs

### Takeaway
The only rich V100 numbers in 2026 come from 1Cat-vLLM at TP4 on 32GB SXM2. One user report of llama.cpp on 2x V100 32GB PCIe roughly matches the user's own baseline.

### Cited Findings
- r/LocalLLaMA (Sept 2026): 2x V100 32GB PCIe on llama.cpp runs Qwen3.8-27B "up to 85 t/s, typically 45-60" and Qwen3.6-35B "up to 135, typically 95-120". Another user calls V100 prompt processing "abysmal" except at FP16 — [reddit snapshot](https://reddit.sentinel-team.org/posts/1w3ue3q/snapshots/2026-09-04T21%3A20%3A12.3645Z)
- 1Cat-vLLM at TP4 on 4x V100-SXM2-32GB: 229/201/171 tok/s at 4K/32K/128K single request with DFlash2, and about 4,069 tok/s prefill at 32K. Without speculation, about 62 tok/s at 128K (NVFP4) — [GitHub 1Cat-vLLM](https://github.com/1CatAI/1Cat-vLLM)
- General guidance: single-user gaps between vLLM and llama.cpp mostly collapse when quant formats are equalized, while vLLM wins heavily under concurrency — [insiderllm](https://insiderllm.com/guides/llamacpp-vs-ollama-vs-vllm/)

### Inferences
- The user's baseline (72-86 tok/s, 2x16GB, IQ3_S + DFlash2) is already at or above the reported llama.cpp V100 numbers. The clearest headroom is long-context decode (33 tok/s at 64-110k vs 1Cat's ~62 tok/s without speculation at 128K on TP4) and prefill (430-650 vs ~4,000 tok/s). Both are attributable to 1Cat's V100 flash-attention. Even halved for TP2, prefill would be several times faster.
- Realistically, "significantly beating" llama.cpp on these nodes requires 1Cat-vLLM. That depends on building it from source on ppc64le/RHEL 7.6 (or in a newer-userland container), on a 4-bit checkpoint that fits 2x16 GB, and on its TP2 path, which the project treats as secondary.

### Gaps
- No TP2-vs-TP1 scaling numbers on NVLink V100 pairs were found for any engine.
- MLC-LLM, Aphrodite, mistral.rs, Candle and KTransformers V100/GDN status was not researched within budget. TGI is in maintenance mode, and Aphrodite is a vLLM fork, so it likely inherits vLLM's sm75 floor (unverified).
