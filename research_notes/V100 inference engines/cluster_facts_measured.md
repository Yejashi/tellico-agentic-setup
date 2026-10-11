# Measured on tellico-compute0, 2026-10-10 (overrides any conflicting claim in other notes)

- OS: Red Hat Enterprise Linux Server release 7.6 (Maipo), ppc64le, glibc 2.17.
- NVIDIA driver 550.54.15, CUDA 12.4 runtime support (nvidia-smi). Toolkits present: /usr/local/cuda-12.4, cuda-12.0, cuda-9.2.
- So the "RHEL 7 ppc64le stops at CUDA 10.2 / driver 440" claim does NOT hold for this cluster: a 550 driver and CUDA 12.4 are installed despite RHEL 7.6. CUDA 12.4.1 remains the last CUDA with Power support, so 12.4 is the ceiling (no CUDA 12.8 as 1Cat-vLLM requires).
- The live llama.cpp (build-v100-mmq) was compiled with spack cuda-12.0.0 nvcc, gcc 9.5.0.
- GPU memory at 2x131072 ctx IQ3_S + DFlash2: GPU0 13084 MiB, GPU1 16004 MiB of 16384.
- Server logs: DFlash2 draft acceptance 0.34-0.37, mean accepted len 3.35-3.60; warm deep session decode ~28-31 t/s at ~77k tokens.

## The cluster's llama.cpp build (checked 2026-10-10)
- /home/bbogale/src/llama.cpp-speedtest is plain upstream ggml-org/llama.cpp, commit c25030496 (2026-10-05). NOT one of the V100 forks (1115714829/llama.cpp-v100, Mitsuasa513/llama.cpp-v100-tuning).
- The source has `--split-mode tensor` and a GGML_CUDA_NCCL option, but build-v100-mmq was configured with GGML_CUDA_NCCL=OFF, so tensor split is not usable in the live build. The rejected `--split-mode row` was the old path, not tensor split.
- GGML_CUDA_FA=ON, FA quants q4_0/q8_0/f16/bf16 compiled.
- An NCCL for ppc64le/CUDA 12.x would be needed to build with NCCL (availability unverified).
