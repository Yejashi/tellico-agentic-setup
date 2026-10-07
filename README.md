# Tellico agentic setup

Portable OpenCode client setup for the Qwen3.8 servers running on the Tellico
cluster. Each compute node serves one model, and the two nodes need not serve
the same one.

The repository contains no API key or SSH private key. The installer retrieves
the model API key through your authenticated Tellico SSH connection and stores
it only on the client device with mode 0600.

## Architecture

| OpenCode provider | Cluster node | GPUs | Slots | Context per slot | Local endpoint |
|---|---|---:|---:|---:|---|
| `tellico-0/qwen3.8-27b` | `tellico-compute0` | 2 x V100 16 GB | 2 | 98,304 | `127.0.0.1:18080` |
| `tellico-1/qwen3.8-27b` | `tellico-compute1` | 2 x V100 16 GB | 2 | 98,304 | `127.0.0.1:18081` |

That is the default layout, with both nodes on the 27B. Either node can be
given a different model instead through a cluster-side profile; see
[Switching the model on a node](#switching-the-model-on-a-node). The rest of
this section describes the 27B profile.

Each server divides one 196,608-token pool across its slots, so slots trade
context for concurrency at no cost in GPU memory. Four concurrent requests fit
cluster-wide; beyond that, requests queue. A single OpenCode session can issue
several at once, because title, summary, compaction, and subagent calls all go
to the same two servers.

The pool is 196,608 rather than the GGUF's full 262,144 because each server also
holds a DFlash2 draft model for speculative decoding, which needs about 560 MiB
of VRAM per GPU. That buys roughly 2.7x generation speed on code and structured
output and about 1.2x on free prose -- measured 87 tok/s versus a 33 tok/s
baseline on a code prompt. The trade is set on the cluster side in
`service.env` (`QWEN38_SPEC_TYPE`, `QWEN38_CTX`); `limit.context` in
`opencode.json` has to match whatever per-slot figure that produces. Because
speculation makes the target evaluate a block of tokens per pass, output is a
valid sample but is not byte-identical to a non-speculative run.

An SSH connection forwards the two private cluster endpoints to localhost.
OpenCode gets a primary orchestration agent and two node-pinned subagents. For
parallelizable work, the primary dispatches one bounded task to each server in
the same Task batch while keeping concurrent write scopes separate.

The cluster side of the service -- the Slurm job, the per-node llama.cpp server
and the commands that start and inspect them -- lives in
[qwen38-cluster](https://github.com/Yejashi/qwen38-cluster), and only the
service owner needs it. The two repositories share the API key path, the port,
the node names and the per-slot context, so a change to capacity on the cluster
means a matching change to `config/opencode.json` here. The model *name* is
the exception: `opencode-tellico` reads it from each server at launch, so a
profile change on the cluster needs no edit here.

## Switching the model on a node

Which model a node serves is a cluster-side choice, made per node by a profile
in `/data/gclab/qwen38/service.env`. The `flashnext` profile serves
Qwen3.8-Flash-Next, 180B total parameters with 6B active per token, at
UD-IQ4_XS:

| Profile | Model | Slots x context | Provider / model id |
|---|---|---:|---|
| `qwen27b` (default) | Qwen3.8-27B Q4_K_M | 2 x 98,304 | `tellico-N/qwen3.8-27b` |
| `qwen27b-pool` | Qwen3.8-27B Q4_K_M | 3 x 65,536 | `tellico-N/qwen3.8-27b-pool` |
| `flashnext` | Qwen3.8-Flash-Next UD-IQ4_XS | 2 x 131,072 | `tellico-N/qwen3.8-flash-next` |

`qwen27b-pool` is the same weights and the same context pool as `qwen27b`,
divided into three slots instead of two. Slots trade context for concurrency at
no cost in GPU memory, so it is the right shape when the 27B is a worker pool
rather than a lead: three concurrent consumers fit, which is the two worker
agents plus the title, summary and compaction calls. It carries its own model
id because `limit.context` must match `QWEN38_CTX / QWEN38_SLOTS`, and one id
cannot be both 98,304 and 65,536.

Flash-Next only fits 16 GB cards because it is sparse. Of its 87.2 GiB of
tensors, 55.4 GiB are MoE experts that `-ncmoe` parks in host RAM and 26.8 GiB
are an n-gram lookup table that llama.cpp gathers straight from the mmap;
roughly 5 GiB has to be GPU-resident. The GPUs reach host RAM over the AC922's
CPU-GPU NVLink at about 77 GiB/s, which is what makes the offload workable.

To put Flash-Next on node 1 and a 27B worker pool on node 0, the service owner
uncomments two lines in `service.env`:

```bash
QWEN38_PROFILE_TELLICO_COMPUTE1=flashnext
QWEN38_PROFILE_TELLICO_COMPUTE0=qwen27b-pool
```

The second is optional. Without it node 0 stays at 2 x 98,304, which works but
leaves the two workers and the housekeeping calls contending for two slots.

then recycles the allocation, which is the only disruptive step:

```bash
ssh tellico 'qwen38-stop && qwen38-submit'
ssh tellico 'qwen38-status --wait'
```

Each client then picks the change up with `tellico-qwen-tunnel restart`. No
client file needs editing: `opencode-tellico` asks each node which model it has
loaded and binds the lead, both workers, and the title, summary and compaction
agents accordingly. With the two nodes differing it prints one line naming what
it resolved.

So in the split layout the node selector also selects the model, and
`opencode-tellico 1` is the intended entry point:

```bash
opencode-tellico 1   # lead on Flash-Next, both workers on the 27B pool
```

That is the shape the setup is for: the lead spends its turns on planning,
decisions and integration on the stronger model, while a pool of 27B workers
absorbs the reading, searching and tracing at roughly 34 tok/s and 257 tok/s of
prefill. `prompts/orchestrate.md` already argues for that division on grounds
of context economy; in a split layout it is also true of capability.

Worker placement follows from the layout. With both nodes on the same model,
worker 0 stays on node 0 and worker 1 on node 1, so a parallel pair uses both
servers. With the nodes on different models, both workers go to the node the
lead is not on -- splitting the pair would put half the bulk reading on the
large slow model and make that worker contend with the lead for its own node's
slots.

Housekeeping -- title, summary and compaction -- also goes to the node not
hosting the lead, which keeps it off the lead's slots. Note the consequence for
the inverse layout: `opencode-tellico 0` leads on the 27B but then puts both
workers *and* the housekeeping on Flash-Next, whose prefill is the slow part.
It works, but it is not what the split layout is tuned for.

To go back, re-comment the line and recycle the allocation again.

## First run

Follow these in order; each step depends on the one before it. Run
`./doctor.sh` at any point to see which step you are on.

1. **Get the repository.** It is private, so the device needs GitHub access
   first:

   ```bash
   git clone git@github.com:Yejashi/tellico-agentic-setup.git
   cd tellico-agentic-setup
   ```

   An HTTPS checkout works too when Git credential authentication is set up:
   `git clone https://github.com/Yejashi/tellico-agentic-setup.git`

2. **Install the tools.** The device needs Linux, macOS, or WSL with a POSIX
   shell, plus `ssh`, `curl`, `sed`, `install`, and
   [OpenCode](https://opencode.ai/docs/) on `PATH`.

3. **Reach the network.** `tellico.icl.utk.edu` is only reachable from the
   site network, so connect to the VPN when off site.

4. **Add an SSH alias** to `~/.ssh/config`, if the device has none:

   ```sshconfig
   Host tellico
     HostName tellico.icl.utk.edu
     User bbogale
     IdentityFile ~/.ssh/id_ed25519
   ```

   Use your own cluster account as `User` if you have one.

5. **Authorize this device.** Every device gets its own key; never copy a
   private key between machines. If this one has no key yet:

   ```bash
   ssh-keygen -t ed25519
   ```

   Then add its *public* key to `~/.ssh/authorized_keys` on Tellico, either
   with `ssh-copy-id -i ~/.ssh/id_ed25519.pub tellico` or by appending it from
   a machine that already has access. `./doctor.sh` prints this device's key
   and both commands, ready to paste.

6. **Install:**

   ```bash
   ./install.sh
   ```

   The installer is idempotent and can be rerun after pulling updates.

7. **Make sure an allocation is running.** The two model servers exist only
   while a Slurm allocation is active:

   ```bash
   tellico-qwen-tunnel cluster-status
   ```

   Only the service owner's account can submit the job. If there is no
   allocation, ask them to start one, then run `tellico-qwen-tunnel restart`.

## Installer options

```text
--ssh-host HOST          SSH hostname or config alias (default: tellico)
--remote-key-path PATH   Model API key path on the cluster, for accounts that
                         read it from somewhere other than the default
--fix-path               Add ~/.local/bin to PATH in the login shell's
                         profile, if it is not there already
--port0 PORT             Local port for tellico-compute0 (default: 18080)
--port1 PORT             Local port for tellico-compute1 (default: 18081)
--no-start               Install the files only, skipping every connectivity
                         check. Use this to set a device up before it has been
                         authorized on Tellico.
```

## Platform notes

**Linux.** The installer enables a systemd user unit, so the tunnel starts at
login and restarts on failure.

**macOS.** There is no systemd, so the tunnel runs as a detached SSH master
instead. It survives closing the terminal, and `opencode-tellico` restarts it
whenever it is not running, but it does not auto-start at login or restart
itself after a mid-session drop. Run `tellico-qwen-tunnel restart` if a session
loses the servers. If the SSH key has a passphrase, add it to the agent once:

```bash
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

**Windows (WSL).** Use a WSL distribution with its own OpenSSH client:

```bash
sudo apt install openssh-client
```

Windows' `ssh.exe` is visible inside WSL through PATH interop, but it reads a
different `~/.ssh` and cannot hold the tunnel's control socket; the installer
stops with instructions if it detects that. Whether the tunnel uses systemd or
a detached SSH master depends on whether your distribution has `systemd=true`
in `/etc/wsl.conf`; both work.

## Troubleshooting

`./doctor.sh` checks tools, SSH config, network, device authorization, the API
key, and the allocation, in that order, and prints the one next step for the
first thing that fails. It is safe to run before installing. After installing,
the same checks plus tunnel health are available as:

```bash
tellico-qwen-tunnel doctor
```

## Use

Start a dual-node OpenCode session with the lead on node 0:

```bash
opencode-tellico 0
```

Or put the lead on node 1:

```bash
opencode-tellico 1
```

Both commands can use both node-pinned subagents. The number only chooses the
model that hosts the lightweight lead conversation.

Non-interactive example:

```bash
opencode-tellico 0 run 'Review this repository and fix the highest-impact issue'
```

Tunnel and cluster checks:

```bash
tellico-qwen-tunnel status
tellico-qwen-tunnel doctor
tellico-qwen-tunnel restart
tellico-qwen-tunnel cluster-status
tellico-qwen-tunnel stop
```

The commands install to `~/.local/bin`. If that is not on PATH, the installer
says so and prints the exact line and file for your login shell. To let it make
the change:

```bash
./install.sh --fix-path
```

That appends the line to `~/.zshrc`, `~/.bashrc` (`~/.bash_profile` on macOS),
`~/.config/fish/config.fish`, or `~/.profile`, depending on `$SHELL`, and does
nothing if the profile already sets it. Open a new terminal afterwards.

## What gets installed

Client side, on each user's own device:

```text
~/.config/tellico-qwen/client.env
~/.config/tellico-qwen/lib/checks.sh
~/.config/tellico-qwen/opencode.json
~/.config/tellico-qwen/prompts/orchestrate.md
~/.config/tellico-qwen/prompts/worker.md
~/.config/tellico-qwen/api-key
~/.local/bin/opencode-tellico
~/.local/bin/tellico-qwen-tunnel
```

On systems with a working systemd user manager, the installer also enables:

```text
~/.config/systemd/user/tellico-qwen-tunnel.service
```

On macOS and other non-systemd systems, the tunnel helper uses a controlled
background SSH master instead.

OpenCode loads `opencode.json` through its supported `OPENCODE_CONFIG` merge
layer, so the device's normal providers and settings remain available. Runtime
overrides pin title, summary, compaction, lead, and worker calls to Tellico for
the launched session.

OpenCode v2 serves plain `opencode` invocations from a shared background
service that was started without `OPENCODE_CONFIG`, which makes it ignore that
variable and report `Model unavailable: tellico-0/qwen3.8-27b`. So
`opencode-tellico` passes `--standalone`, giving the session its own server
that does read the config. The flag is used only when the installed OpenCode
advertises it, so older versions without a background service are unaffected.
Force the choice with `TELLICO_OPENCODE_STANDALONE=1` or `=0`.

## Allocation lifecycle

The two model servers exist only while the Tellico Slurm allocation is active.
Check it with:

```bash
tellico-qwen-tunnel cluster-status
```

That check needs no privileged access: it reads the queue with `squeue` and
probes each server's authenticated `/v1/models`, both of which any cluster
account may do.

When an allocation has expired, the owner of the service account submits
another one:

```bash
ssh tellico qwen38-submit
ssh tellico 'qwen38-status --wait'
```

Everyone else then picks the new servers up with:

```bash
tellico-qwen-tunnel restart
```

Using a custom SSH alias requires replacing `tellico` in the submit commands or
setting `TELLICO_SSH_HOST` for that shell.

### Shared access

The model API key lives in the lab's shared space rather than in the service
owner's home directory, which is not traversable by other accounts:

```text
/data/gclab/qwen38/secrets/api-key    mode 0640, group gclab
```

Any `gclab` member can therefore install this repository under their own
cluster account with no extra flags. Someone outside that group needs a copy
they can read, passed with `--remote-key-path`.

These names are defaults, not assumptions. Override them per shell:

```text
TELLICO_REMOTE_KEY_PATH   Path to the API key on the cluster
TELLICO_SERVICE_USER      Account that owns the allocation (default: bbogale)
TELLICO_JOB_NAME          Slurm job name (default: qwen38-api)
TELLICO_COMPUTE_NODES     Space-separated server hostnames
TELLICO_MODEL_PORT        Port the servers listen on (default: 8000)
```

## Update

```bash
git pull --ff-only
./install.sh
```

## Uninstall

```bash
./uninstall.sh
```

The uninstaller removes only files installed by this repository. It does not
remove OpenCode, SSH configuration, any cluster files, or a PATH line added by
`--fix-path`, since other tools in `~/.local/bin` may depend on it.

## Security model

- Both model forwards bind only to `127.0.0.1`.
- The model API key is fetched over SSH and stored with mode 0600.
- No API key is written into OpenCode JSON or the systemd unit.
- The repository contains no private credentials and can safely be cloned.
- Access still requires both Tellico SSH authorization and the cluster API key.
- The API key is shared by every user, so it identifies the service rather than
  the caller. `llama-server --api-key-file` accepts one key per line, so moving
  to per-user keys is the way to get revocation and attribution.
