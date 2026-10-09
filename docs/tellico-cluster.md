# The Tellico cluster

A guide for a new user of Tellico, the small IBM POWER9 GPU cluster run by the
Innovative Computing Laboratory (ICL) at the University of Tennessee, Knoxville.
It covers the machine itself -- hardware, access, storage, software and the
batch system -- and the traps that are not obvious from the documentation.
Nothing here depends on the model service that this repository connects to.

Facts were read from the cluster on 2026-10-09. Where the cluster's own notes
disagree with what it actually does, this file says so.

## At a glance

| | |
|---|---|
| Entry point | `tellico.icl.utk.edu` (site network or VPN only) |
| Architecture | **ppc64le** (IBM POWER9), not x86 |
| OS | Red Hat Enterprise Linux 7.6, kernel 4.14 (`el7a`) |
| GPU nodes | 2, each with 2 x NVIDIA Tesla V100-SXM2-16GB |
| Batch system | Slurm 20.11.9 |
| Max job length | 24 hours (default 1 hour) |
| Shared storage | GPFS: `/home`, `/data`, `/scratch` |
| Software | Environment modules built with Spack |

## Nodes

| Host | Role | Slurm feature | State |
|---|---|---|---|
| `tellico-master0` | Login node; where every SSH session lands | -- | up |
| `tellico-master1` | CPU-only compute node | `cpu` | `down*` |
| `tellico-compute0` | GPU compute node | `gpu` | up |
| `tellico-compute1` | GPU compute node | `gpu` | up |

In practice the cluster is **two GPU nodes**. `tellico-master1` has been down,
so a job asking for `-C cpu` will not start.

## Hardware

The compute nodes are IBM Power System AC922 machines (the same building block
as the Summit and Sierra supercomputers):

| Component | Per node |
|---|---|
| CPU | 2 x POWER9 (altivec), 16 cores each, SMT4: **128 hardware threads**, 2.3-3.8 GHz |
| NUMA | 2 nodes, numbered **0 and 8** (CPUs 0-63 and 64-127) |
| Memory | ~123-160 GB visible to the OS, split across the two NUMA nodes |
| GPUs | 2 x Tesla V100-SXM2-16GB, compute capability **7.0** (sm_70), one per socket |
| Local disk | ~900 GB XFS on `/` |
| Network | Dual-rail 100 Gb/s InfiniBand (Mellanox ConnectX-5); IPoIB bonded as `bond0`, 192.168.230.0/24 |

The login node is the same class of POWER9 machine but has no usable GPU
driver: `nvidia-smi` fails there. Run anything that needs a GPU through Slurm.

### Topology: what makes this machine unusual

**The CPU and GPU are joined by NVLink 2.0**, about 77 GB/s per GPU (3 links x
~25.8 GB/s) -- several times what a PCIe 3 x16 slot gives on an x86 server.
Host memory is therefore unusually close to the GPU. Workloads that stream
data from host RAM to the GPU, or that keep part of a model in host RAM, do
much better here than the V100's age suggests.

**The two GPUs in a node are *not* joined to each other by NVLink.**
`nvidia-smi topo -m` reports `SYS` between GPU0 and GPU1: they sit on different
sockets, and GPU-to-GPU traffic crosses the inter-socket bus. Plan for that:

- Tensor or data parallelism that exchanges data between the two GPUs every
  step pays a heavy penalty.
- Splitting a model by layers across the two GPUs works, but runs the halves
  in sequence: two GPUs give you twice the memory (32 GB), not twice the speed.
- Pin each process to the socket that owns its GPU (`numactl`, or
  `--cpu-bind` in Slurm) to avoid cross-socket memory traffic.

### What the V100 cannot do

- **No bf16.** sm_70 has fp16 and fp32 tensor cores only. Models or kernels
  that assume bf16 must be converted to fp16 or will fall back to slow paths.
- **No FlashAttention 2 or later** in the official builds, and no fp8 or
  sparsity features; those need Ampere (sm_80) or newer.
- 16 GB per GPU, 32 GB per node, 64 GB across the cluster.

## Access

1. Get an account from ICL. Accounts are personal; never share a login, and do
   not use someone else's account even if you have their permission.
2. Be on the UT site network, or the VPN when off site. `tellico.icl.utk.edu`
   does not answer from the open internet.
3. Use SSH keys, one per device. A convenient `~/.ssh/config` entry:

   ```sshconfig
   Host tellico
     HostName tellico.icl.utk.edu
     User YOUR_ACCOUNT
     IdentityFile ~/.ssh/id_ed25519
   ```

Every connection lands on `tellico-master0`. Its welcome banner points to
`/opt/slurm_info.txt` for batch instructions; see the Slurm section for where
that file is out of date.

## Storage

| Path | Filesystem | Size (Oct 2026) | Use it for |
|---|---|---:|---|
| `/home/$USER` | GPFS, shared | 11 TB total, ~3 TB free | Code, configs, modest datasets, model weights |
| `/data` | GPFS, shared | 26 TB, ~16 TB free | Project and group directories (`/data/<project>`) |
| `/scratch` | GPFS, shared | 26 TB, nearly empty | Large temporary job data |
| `/` and `/tmp` | Local XFS, per node | ~900 GB | Fast node-local scratch inside a job |

- `/home`, `/data` and `/scratch` are visible from every node. **Node-local
  paths are not**: a file written to `/tmp` on the login node does not exist on
  a compute node. Anything a job reads must be on GPFS or copied in by the job.
- No quotas or purge policy are published. Treat `/home` as shared and finite.
- `/data/example_job_scripts` holds the cluster's sample MPI programs and batch
  scripts.

## Software

### Modules

Software comes from Spack-built environment modules under `/apps/spack`. Two
trees are visible: the current one (built with GCC 9.5.0, 2023) and an older
one (GCC 7.3/9.2, 2020). Prefer the current tree.

```bash
module avail            # everything
module list             # what is loaded
module load cuda/12.1.1 gcc/11.4.0
```

**The login profile loads modules for you** -- `git`, `vim`, `python/3.10.10`,
`cmake`, `ninja`, `tmux`, `gcc/9.5.0` and `cuda/12.0.0` among them -- and
prints `Loading ...` lines on every login, including non-interactive `ssh host
command` calls. Scripts that parse remote output need to filter those lines.

Notable modules in the current tree:

| Area | Versions |
|---|---|
| Compilers | `gcc` 7.5, 8.5, 9.5, 10.4, 11.3, 11.4, 13.1; `llvm` 11, 14, 16; `nvhpc` 23.5; `aocc` 4.0 |
| CUDA | 10.2, 11.0-11.8, 12.0, 12.1 (also `/usr/local/cuda-12.0`, `-12.4`, `-9.2`) |
| GPU libraries | `nccl` 2.18, `magma` 2.7, `kokkos` 4.0 |
| MPI | `openmpi` 3.1-4.1, `mpich` 4.1, `mvapich2` 2.3, `ucx` 1.14 |
| Math | `openblas`, `netlib-lapack`, `netlib-scalapack`, `fftw`, `plasma`, `superlu`, `metis` |
| Profiling | `papi`, `likwid`, `valgrind`, `gperftools`, `otf2`, `cubelib`, `hpl` |
| Languages | `python` 3.8 and 3.10, `go` 1.20, `lua` 5.4, `jdk` 1.8 (old tree) |
| Containers | `apptainer` 1.1.7; `singularity` and `docker` binaries also exist |
| Tools | `git`, `gh`, `tmux`, `htop`, `the-silver-searcher`, `gdb`, `cmake`, `ninja` |

### ppc64le: expect to build from source

Most prebuilt binaries in the Python and ML ecosystems are x86-only. On
Tellico:

- `pip install` of anything with compiled code (PyTorch, vLLM, most CUDA
  wheels) usually finds no ppc64le wheel and either fails or tries a long
  source build. Check for a ppc64le build before planning around a package.
- Container images must be built for `linux/ppc64le`; ordinary Docker Hub
  images will not run.
- Build GPU code for `sm_70` (`-arch=sm_70`, `CMAKE_CUDA_ARCHITECTURES=70`).
- The system glibc is RHEL 7's (2.17), which recent prebuilt binaries
  sometimes reject even on the right architecture.

Projects that build cleanly from source with CMake and CUDA, such as
llama.cpp, work well.

## Slurm

### Partitions

| Partition | Default | Sharing | Time limit |
|---|---|---|---|
| `shared` | yes | Up to **4 jobs per node** (`OverSubscribe=FORCE:4`) | default 1 h, max 24 h |
| `exclusive` | no | Whole node to one job | default 1 h, max 24 h |

Scheduling is backfill with basic (first-come) priority, no preemption and no
accounting enforcement, so there are no fair-share limits, QOS or allocations
to request. Arrays of up to 1001 tasks are allowed.

**GPUs are not a Slurm resource here.** `GresTypes=gpu` is configured but no
node declares any, so `--gres=gpu:1` and `--gpus` do not work. Select GPU
nodes with the feature constraint instead, and coordinate GPU use with anyone
sharing the node:

```bash
srun -C gpu -t 120 ./my_app                 # a GPU node, shared partition
srun -p exclusive -C gpu -t 120 ./my_app    # a GPU node to yourself
sbatch -p exclusive -N2 -C gpu job.sh       # both GPU nodes
```

On the `shared` partition another job can be running on the same GPUs. If you
need predictable GPU memory or timing, use `exclusive`. Note that the node
selection plugin is `select/linear`, which allocates whole nodes, so a node
already holding a job may show all 128 CPUs allocated.

The batch instructions in `/opt/slurm_info.txt` date from an older layout: they
mention four nodes and `-C cpu` jobs, but only the two GPU nodes are up today.

### Checking state

```bash
sinfo                       # partitions and node states
sinfo -N -o "%N %f %T"      # nodes, features, states
squeue                      # everything queued or running
squeue -u $USER
scontrol show job JOBID
```

`sacct` and `sacctmgr` do not work: there is no Slurm accounting database.
Keep your own job logs (`#SBATCH -o`/`-e`) if you need history.

### Memory limits

Slurm does not track memory on these nodes (`RealMemory=1`,
`DefMemPerNode=UNLIMITED`), so `--mem` is not enforced and not a reliable way
to reserve RAM.

There is, however, a hard limit that catches most people out:

**Every process is capped at 64 GiB of virtual address space.**
`/etc/profile.d/limit.sh` runs `ulimit -v 67108864` at login, which in a bare
`ulimit` lowers both the soft and the hard limit. Slurm is configured with
`PropagateResourceLimits=ALL`, so your login shell's limit follows you into
every job. A program that maps or reserves more than 64 GiB -- large model
weights, big `mmap`ed datasets, CUDA's own address reservations -- fails with
`mmap failed: Cannot allocate memory` or `std::bad_alloc` while most of the
node's RAM sits free.

Two ways out, both effective inside a job:

```bash
# In your batch script, before the program starts.
# Works because the hard limit inside a Slurm job is unlimited.
ulimit -v unlimited

# Or stop Slurm propagating the login limit at all.
srun --propagate=NONE ./my_app
```

## Working remotely: SSH traps

These come from running commands on the login node over SSH, and each has
cost real time.

- **The login profile swallows stdin.** `ssh tellico 'cat > file' < local`
  produces an empty file, because the module loads at login consume the input.
  Copy files with `scp` or `rsync`.
- **`pkill -f` kills your own shell.** Inside `ssh tellico 'pkill -f foo'`,
  the remote `bash -c` command line itself contains `foo`, so it matches and
  kills itself. Find the PID with `ps -u $USER -o pid,ppid,etime,args` and
  kill that.
- **Background jobs hold the connection open.** A remote `setsid cmd &` can
  keep the SSH channel from closing. Start it with `ssh -n tellico '...' &`
  from your own machine and check on it from a second connection, or better,
  run it under `tmux` or as a Slurm job.
- **Killing children is not killing a script.** A download or retry loop whose
  `curl`s you kill will often just reconnect. Kill the whole process tree, then
  confirm nothing is left before cleaning up its output.
- **Large downloads:** some hosts (Hugging Face among them) cap each connection
  at ~18 MiB/s but serve several at once, so parallel range requests are
  several times faster than a single stream.

## Hardware faults to recognise

GPU memory-management faults appear in the node's kernel log as
`NVRM: Xid 31` (an MMU fault, with the copy engine and `VIRT_READ` or
`VIRT_WRITE` named). On Tellico they have been seen under sustained heavy
host-to-GPU copying, with clean ECC and no retired pages -- that is, a
software/driver interaction with NVLink host access rather than failing
hardware. The process that triggered it dies; the GPU recovers. If a GPU job
dies unexplained, check `dmesg` on that node for an Xid before suspecting your
own code, and make long-running GPU services restart themselves rather than
assume they will not crash.

## Quick reference

```bash
ssh tellico                                   # lands on tellico-master0
module avail; module load cuda/12.1.1         # software
sinfo; squeue -u $USER                        # cluster and your jobs
srun -C gpu -t 60 --pty bash                  # interactive shell on a GPU node
srun -p exclusive -C gpu -t 240 --pty bash    # same, node to yourself
nvidia-smi; nvidia-smi topo -m                # on a compute node only
ulimit -v unlimited                           # first line of any big-memory job
cat /opt/slurm_info.txt                       # the cluster's own (dated) notes
```
