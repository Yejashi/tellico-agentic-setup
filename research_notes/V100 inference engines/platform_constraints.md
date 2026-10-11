# Platform constraints and theoretical decode ceilings: AC922 (POWER9, ppc64le) + V100-SXM2-16GB on RHEL 7.6 (as of 2026-10-10)

## Q1. What CUDA toolkit and driver can RHEL 7.6 ppc64le actually run, and when did NVIDIA drop Power and Volta?

### Takeaway
NVIDIA's own RHEL 7 ppc64le repository stops at **CUDA 10.2 and driver 440.118.02**, with no 11.x or 12.x packages. CUDA on Power continued only on RHEL 8: the last release was **12.4.1** (March 2024), deprecated in 12.4.0 and removed in 12.5.0. Volta lost offline compilation and library support in **CUDA 13.0**. Containers cannot get around this, because the kernel driver is the limit, and CUDA 11.x forward compatibility needs a base driver of r450 or newer.

### Cited Findings
- NVIDIA's `repos/rhel7/ppc64le` index has `cuda-toolkit-10-2-10.2.89` (2019-11-15) as its newest toolkit. Its highest driver is `cuda-drivers-440.118.02` (2020-09-03), and the latest upload is an R418 maintenance driver `418.226.00` (2021-10-05). I checked the whole listing in two passes and found no CUDA 11.x/12.x toolkit packages and no driver above 440. — [NVIDIA rhel7/ppc64le repo](https://developer.download.nvidia.com/compute/cuda/repos/rhel7/ppc64le/)
- NVIDIA's `repos/rhel8/ppc64le` index goes up to `cuda-12.4.1` (2024-03-28), with drivers up to `535.216.03` (2024-10-26) and `550.54.15` (2024-03-06). — [NVIDIA rhel8/ppc64le repo](https://developer.download.nvidia.com/compute/cuda/repos/rhel8/ppc64le/)
- Robert Crovella (NVIDIA), 2024-07-26: "CUDA 12.4.0 deprecated support for Power architecture... still supported in CUDA 12.4.1, but only on RHEL8. Support was evidently removed in CUDA 12.5.0." There is no RHEL 9 ppc64le driver. The poster was on an **AC922 with 4x V100** and could not move to EL9. — [NVIDIA forum: Missing CUDA drivers for ppc64le on RHEL9](https://forums.developer.nvidia.com/t/missing-cuda-drivers-for-ppc64le-on-rhel9/301323)
- Debian packaging notes say cuDNN 9.0.0.312 was the last cuDNN for ppc64el, and that ppc64el is unsupported after CUDA 12.4. — [Debian tracker](https://tracker.debian.org/news/1610375/accepted-nvidia-cudnn-900312cuda12-source-into-unstable/)
- Bede, a UK HPC system documented here as POWER9/Open-CE, migrated RHEL 7 to RHEL 8 (finished 2022-05-03). Its notes say RHEL 8 "enables newer software, including CUDA 11, which RHEL 7 did not support". glibc goes from 2.17 to 2.28 and default gcc from 4.8.5 to 8.5.0. — [Bede RHEL 8 migration](https://bede-documentation.readthedocs.io/en/latest/rhel8/index.html)
- The NVIDIA forum has a thread titled "Why no CUDA 11.x on Power9 with RHEL7?" (2021-03-03), linked from the thread above. I did not read its content. A separate user reported that "the last CUDA version for a Power8 rhel 7.7 is the 10.2". — [NVIDIA forum (Power8/RHEL7.7)](https://forums.developer.nvidia.com/t/cuda-11-0-required-for-power8-rhel-7-7/147824)
- CUDA 13.0 removed offline compilation and library support for Maxwell, Pascal and Volta. 12.x toolkits can still build for them. — [CUDA Features Archive](https://docs.nvidia.com/cuda/cuda-features-archive/index.html)
- PyTorch 2.12 keeps a CUDA 12.6 "legacy" build for Maxwell/Pascal/Volta because CUDA 13.x does not support them. — [PyTorch dev-discuss, Release 2.12](https://dev-discuss.pytorch.org/t/introducing-cuda-13-2-and-deprecating-cuda-12-8-release-2-12/3337)
- CUDA forward compatibility (`cuda-compat`) works only on data-center GPUs. It needs a base driver of **r450+ for CUDA 11.x compat**, **r525+ for 12.x** and **r580+ for 13.x**. In the current table the oldest supported base branch is 535, and the page does not mention ppc64le. — [NVIDIA CUDA forward compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/forward-compatibility.html)
- Real-world POWER9 + V100 install: AlmaLinux 8.10, driver 550.54.15, CUDA 12.4.131, 4x V100-SXM2-32GB. — [IBM community thread, 2025-03-14](https://community.ibm.com/community/user/discussion/server-crashes-after-starting-vllm-and-ollama-power9)

### Inferences
- On stock RHEL 7.6 ppc64le with NVIDIA-packaged drivers, the newest stack is CUDA 10.2 on driver 440. Nothing modern (PyTorch 2.x CUDA builds, vLLM, FlashAttention, Triton) targets CUDA 10.2.
- An Apptainer/Singularity container can carry a newer glibc and userland (for example a RHEL 8/9 or Ubuntu ppc64le base). It still uses the **host kernel driver**. With driver 440, forward compatibility cannot lift it to CUDA 11 or 12, because 11.x compat needs r450 and 12.x needs r525. So **containers fix glibc 2.17 but not the CUDA ceiling**. The real unlock is a host OS move to RHEL 8.x plus driver 535 or 550, which allows CUDA up to 12.4.1. That is an admin-level change, not something a user can do.
- **Contradiction to resolve:** the cluster already runs a recent llama.cpp with CUDA on these nodes. llama.cpp's CUDA backend on RHEL 7.6 is hard to square with a 440 driver, so the cluster probably has a non-repo driver installed (runfile), runs a different OS than "7.6", or uses a container plus something else. The cluster's actual `nvidia-smi` driver version and `nvcc --version` decide everything in Q2. They should be checked before ruling out any other engine.
- Even in the best case (RHEL 8 + 12.4.1), CUDA on Power is frozen at 12.4.1 (2024), and Volta is frozen at CUDA 12.x. No future toolkit will serve this hardware.

### Gaps
- I did not fetch the CUDA 11.0/12.0 release notes' "dropped OS" tables, so I have no official NVIDIA sentence saying RHEL 7 ppc64le support ended at 10.2. The evidence is the repository contents plus Bede's statement.
- I did not confirm whether NVIDIA published ppc64le runfile drivers newer than 440 that install on RHEL 7.
- I did not check whether any OLCF Summit or LLNL Sierra documents record their final OS, driver or CUDA versions. Summit was retired in November 2024, which is my knowledge and was not verified here.

## Q2. Can PyTorch, Triton, vLLM, SGLang, TensorRT-LLM, LMDeploy or ExLlama be built or deployed on ppc64le + V100?

### Takeaway
Every alternative engine depends on a CUDA-enabled PyTorch for ppc64le, and most also need Triton. The last CUDA PyTorch for Power was Open-CE around PyTorch 2.1.x (CUDA 11.8/12.2), and current IBM ppc64le wheels are CPU-oriented with glibc 2.34+ tags. vLLM's ppc64le support is CPU-only, a POWER9+V100 vLLM GPU attempt crashed with no fix, and vLLM itself appears to have dropped sm_70 around v0.20. I found **no documented case of any GPU LLM serving engine other than llama.cpp/Ollama running on POWER9+V100**.

### Cited Findings
- Open-CE 1.11.0 is the newest Open-CE release I found and ships `pytorch-base 2.1.2`. Jax is not available for PPC CUDA builds. — [Open-CE v1.11.0 release](https://github.com/open-ce/open-ce/releases/tag/open-ce-v1.11.0)
- Open-CE 1.9.1 was built with CUDA 11.8, Python 3.9/3.10 and PyTorch 2.0.1. — [IBM community, Open-CE 1.9.1 (2023-09-27)](https://community.ibm.com/community/user/blogs/maximilllian-schmidt/2023/09/27/open-ce-version-191)
- Rocket CE shipped CUDA builds of PyTorch 2.0.1 for Power (CUDA 12.2 and 11.8), in a January 2024 post. — [Rocket Software community](https://community.rocketsoftware.com/discussion/releasing-rocketce-pytorch-v201-with-opence-v1100)
- "The upstream Conda and pip distributions do not provide ppc64le pytorch packages". The route is the Open-CE OSU channel `https://ftp.osuosl.org/pub/open-ce/current/`. NGC has no ppc64le containers. — [Bede PyTorch docs](https://bede-documentation.readthedocs.io/en/latest/software/applications/pytorch.html)
- IBM's ppc64le wheel index has `torch 2.10.0+ppc64le1` (cp311 uploaded 2026-03-27, cp312 2026-05-11), tagged `manylinux_2_34_ppc64le`, which means glibc ≥ 2.34. It carries no CUDA tag. — [IBM wheels: torch 2.10.0](https://wheels.developerfirst.ibm.com/ppc64le/linux/torch/2.10.0+ppc64le1); [IBM blog on the wheel repo (2025-08-01)](https://community.ibm.com/community/user/blogs/nikhil-kalbande/2025/08/01/install-wheels-from-ibm-python-wheel-repository)
- vLLM added ppc64le support (PR #5652) and builds with `Dockerfile.ppc64le`. This is the CPU backend. — [IBM blog, 2024-06-27](https://community.ibm.com/community/user/powerdeveloper/blogs/manjunath-kumatagi/2024/06/27/run-vllm-on-ppc64le-architecture)
- IBM's ppc64le vLLM wheel index: "Latest version on stage is: 0.8.4+cpu". — [IBM wheels: vllm](https://wheels.developerfirst.ibm.com/ppc64le/linux/vllm)
- A 2026 IBM guide sets up vLLM 0.11.1 on Power with gcc-toolset-14 and Python 3.12, targeting Power11 CPUs. — [IBM community, 2026-02-09](https://community.ibm.com/community/user/blogs/maryam-nezamabadi/2026/02/09/set-up-and-run-vllm-on-ibm-power)
- POWER9 + 4x V100 on AlmaLinux 8.10 / CUDA 12.4: Docker vLLM "runs well on cpu. When I try to run it via gpu, it crashes". Ollama behaved the same. The thread had no resolution as of a 2026-03-10 follow-up. — [IBM community thread](https://community.ibm.com/community/user/discussion/server-crashes-after-starting-vllm-and-ollama-power9)
- vLLM 0.20.0 does not support V100 (sm_70) "even with CUDA 12.6". The suggestion is to stay on ≤0.18.x. The thread is dated 2026-04-30, and the answer is an unverified AI-bot reply. — [vLLM forum](https://discuss.vllm.ai/t/support-for-v100-sm-70-on-vllm-0-20/2605)
- Red Hat's AIPCC-7492: ppc64le builds of llvm-triton were disabled for stability problems and later re-enabled for a ppc64le **CPU** UBI9 image. — [Red Hat Jira AIPCC-7492](https://issues.redhat.com/browse/AIPCC-7492)
- People have compiled torch from source on Power9/10 because no prebuilt wheels exist. — [PyTorch forums: Torch ppc64le wheels](https://discuss.pytorch.org/t/torch-ppc64le-wheels/208772)
- I found no OLCF Summit or LLNL Sierra documentation of vLLM or another LLM serving engine. The searches returned nothing relevant. — (no source; see Gaps)

### Inferences
- **vLLM / SGLang**: need CUDA PyTorch plus Triton plus custom CUDA kernels. On ppc64le that means building PyTorch 2.x from source against CUDA ≤12.4.1, building Triton for a ppc64le host targeting sm_70 (no upstream support found), and pinning a vLLM version from before the sm_70 drop. Each step is plausible in isolation but undocumented, and the one public attempt failed. SGLang leans harder on FlashInfer and Triton, which makes it worse. Unrealistic.
- **TensorRT-LLM**: NVIDIA ships it for x86_64 and aarch64 only, and has not supported Volta in recent releases. This is my understanding and was not verified in this session. Treat it as not deployable.
- **LMDeploy (TurboMind)**: C++/CUDA core with a Python front end. It historically supported sm_70, but it still needs PyTorch and has no ppc64le packaging. Not verified.
- **ExLlamaV2/V3**: need CUDA PyTorch and JIT-compile extensions. ExLlamaV2 kernels are known to run on sm_70 in practice, but this was not verified here. On ppc64le this is gated by the PyTorch problem above.
- **What can realistically be built**: pure C/C++ + CUDA engines with no PyTorch dependency. That is llama.cpp (already used) and its forks (ik_llama.cpp), plus possibly MLC-LLM/TVM (needs LLVM on ppc64le, unverified). A user-buildable improvement is therefore far more likely to come from llama.cpp-family kernels or a different quant format than from switching engines.
- glibc 2.17 is separately a blocker for any modern Python wheel (IBM's torch wheels need glibc 2.34). That part is solvable with an Apptainer image if the host has Apptainer/Singularity. The CUDA driver ceiling in Q1 is not.

### Gaps
- I did not verify the current Triton upstream position on ppc64le hosts with NVIDIA GPUs, or on sm_70 (pre-Turing) targets.
- I did not check whether Open-CE has shipped anything after 1.11 (late 2024 to 2026), so the newest CUDA PyTorch for ppc64le could be slightly newer than 2.1.2.
- I did not confirm whether Apptainer/Singularity is installed on the Tellico nodes.
- I found no public report of ExLlama, LMDeploy, MLC-LLM or SGLang running on POWER9.

## Q3. What are the memory-bandwidth decode ceilings, and how much headroom is realistic?

### Takeaway
Without speculation, the bandwidth ceiling for 11.8 GB of IQ3_S weights is **~76 tok/s** on a layer split, because the GPUs take turns, so the effective bandwidth is 900 GB/s. Ideal 2-GPU tensor parallelism gives **~152 tok/s**. Realistic figures are roughly **~60 tok/s** for a layer split and **~95-115 tok/s** for tensor parallelism. Today's measured 72-86 tok/s with speculation fits a raw decode of about 25-40 tok/s, which uses only ~35-50% of one GPU's bandwidth. That points to **kernel efficiency (IQ3_S dequant on Volta) and tensor parallelism as the real headroom**, not the engine as such.

### Cited Findings
- V100-SXM2 HBM2 bandwidth is 900 GB/s per GPU. This is the figure given in the task. It is well established but I did not re-fetch a source this session.
- Single-request decode is memory-bandwidth-bound. — [mgroeber, benchmarking llama.cpp on legacy hardware](https://www.mgroeber.de/benchmarking-llamacpp-on-legacy-hardware-2.html)
- Anecdotal calibration: 2x V100-32GB with NVLink, llama.cpp tensor-split, **Qwen 3.8 27B Q5_K_M**, 256k context, MTP speculative decoding: "Decode: probably average 55 tps, bounces between 40 and 70". This is an informal Reddit report and not a controlled batch-1 number. — [r/LocalLLM via redlib](https://redlib.groet-infra.nl/r/LocalLLM/s/4w8CIf9Q38)
- I found no controlled V100 batch-1 decode benchmark for a 27-34B model in any engine. A 3x V100 vLLM benchmark covers only ≤14B models at 50-100 concurrency. — [DatabaseMart 3xV100 vLLM](https://www.databasemart.com/blog/vllm-gpu-benchmark-v100-3)

### Arithmetic (my calculations from the stated inputs)
Weight bytes per token are roughly equal to the model file size, since every weight is read once per decode step at batch 1. KV and DeltaNet state reads come on top.

| Weights | Size | Layer split (900 GB/s eff.) | Same at 80% achievable BW | Ideal TP=2 (1800 GB/s) |
|---|---|---|---|---|
| IQ3_S ~3.5 bpw (27e9 × 3.5 / 8) | 11.8 GB | 900/11.8 = **76.3 tok/s** (13.1 ms) | 61.0 tok/s | 152.5 tok/s (6.6 ms) |
| 4.0 bpw | 13.5 GB | 66.7 tok/s | 53.3 tok/s | 133.3 tok/s |
| 4.5 bpw | 15.2 GB | 59.2 tok/s | 47.4 tok/s | 118.4 tok/s |

Check: 11.8 GB × 8 / 27e9 = 3.50 bpw, which matches "~3.4 bpw" (the embedding and output tensors are usually kept at higher precision).

- **Layer split (llama.cpp's default `-sm layer`)**: GPU0 reads 5.9 GB in 6.6 ms, then GPU1 reads 5.9 GB in 6.6 ms. Total 13.1 ms gives 76 tok/s. The second GPU adds capacity but no speed.
- **Tensor parallel**: each GPU reads 5.9 GB at the same time, 6.6 ms in the ideal case. The cost is 2 allreduces per transformer layer. Assuming ~64 layers (unverified for Qwen3.8-27B) and ~10-20 µs per small NVLink allreduce (assumed, not measured here), that is 128 × 10-20 µs = **1.3-2.6 ms per token**. Ceiling: 6.6 + 1.3-2.6 = 7.9-9.2 ms, or **~109-127 tok/s**. At 80% bandwidth: 8.2 + 1.3-2.6 = 9.5-10.8 ms, or **~93-105 tok/s**.
- **Speculation implies the raw rate**: with a mean accepted length of 3.5, 72-86 tok/s means about 20.6-24.6 verify steps/s, or **~41-49 ms per step** (verification plus drafter). The no-spec ceiling for one step is 13.1 ms. Each step therefore costs about 3-4 single-token decodes. Two reasons are likely: a verify batch of several tokens makes IQ3_S dequantization compute- or latency-bound on Volta, which has no int8 tensor-core path for i-quants (inference, not verified), and the drafter itself costs time.
- **Raw rate vs the ceiling**: if raw decode is 25-35 tok/s, effective weight bandwidth is 25-35 × 11.8 = **295-413 GB/s, 33-46% of 900 GB/s**. A well-tuned bandwidth-bound kernel typically reaches 70-85% of peak (rule of thumb, not cited). That leaves **~1.7-2.3x headroom on raw decode from kernels alone**, before tensor parallelism.
- **Long context (33 tok/s at 64-110k)**: here per-token cost is dominated by the full-attention layers' KV reads plus attention compute, not weights. Tensor parallelism splits KV heads across GPUs, so it helps this regime about as much as the weight reads.

### Inferences
- The best realistic target for raw single-stream decode on this hardware is **~55-60 tok/s with a layer split** and **~90-110 tok/s with tensor parallelism**. With speculation at acceptance ~3.5 on top, short-context output could in principle reach about 1.5-2x today's 72-86 tok/s. That assumes verify steps cost close to a plain decode, which is the hard part on Volta.
- Within llama.cpp's family, the levers are: `-sm row` or llama.cpp's newer tensor-parallel split mode, if the build has it (llama.cpp's row split is known to scale poorly; unverified here); a K-quant or other format with cheaper dequantization on sm_70 instead of IQ3_S; and ik_llama.cpp kernels. All of these avoid the PyTorch and driver blockers in Q1 and Q2.
- Prefill (430-650 tok/s) is compute-bound. V100 FP16 tensor cores (~125 TFLOPS peak) would in theory allow 125e12 / (2 × 27e9) ≈ 2,300 tok/s at 100% MFU. So prefill has a larger relative headroom (3-5x) than decode, but only with tensor-core-friendly kernels.
- Raising tok/s by switching to vLLM/SGLang/TensorRT-LLM is mostly ruled out on platform grounds (Q1/Q2), independent of these ceilings.

### Gaps
- No controlled batch-1 decode number for any 27-34B model on V100 in any engine. The only calibration point is the Reddit anecdote above, which is about 55 tok/s with MTP on Q5_K_M.
- Qwen3.8-27B layer count and the split between full-attention and Gated-DeltaNet layers were not verified, so the allreduce count is an assumption.
- I did not measure NVLink 2.0 small-message allreduce latency on AC922. 10-20 µs is an estimate.
- The raw no-spec decode rate on the cluster has not been measured. Running `llama-bench` without the drafter, with `-sm layer` and `-sm row`, would replace the 25-35 tok/s assumption with data.
