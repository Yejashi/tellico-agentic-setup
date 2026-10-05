# Tellico agentic setup

Portable OpenCode client setup for the two Qwen3.8-27B servers running on the
Tellico cluster.

The repository contains no API key or SSH private key. The installer retrieves
the model API key through your authenticated Tellico SSH connection and stores
it only on the client device with mode 0600.

## Architecture

| OpenCode provider | Cluster node | GPUs | Context | Local endpoint |
|---|---|---:|---:|---|
| `tellico-0/qwen3.8-27b` | `tellico-compute0` | 2 x V100 16 GB | 262,144 | `127.0.0.1:18080` |
| `tellico-1/qwen3.8-27b` | `tellico-compute1` | 2 x V100 16 GB | 262,144 | `127.0.0.1:18081` |

An SSH connection forwards the two private cluster endpoints to localhost.
OpenCode gets a primary orchestration agent and two node-pinned subagents. For
parallelizable work, the primary dispatches one bounded task to each server in
the same Task batch while keeping concurrent write scopes separate.

## Prerequisites

The client device needs:

- Linux, macOS, or WSL with a POSIX shell;
- [OpenCode](https://opencode.ai/docs/) on `PATH`;
- `ssh`, `curl`, `sed`, and `install`;
- network access to `tellico.icl.utk.edu` (including the appropriate VPN when
  off site); and
- an SSH key authorized for the `bbogale` Tellico account.

Create an SSH alias if the device does not already have one:

```sshconfig
Host tellico
  HostName tellico.icl.utk.edu
  User bbogale
  IdentityFile ~/.ssh/id_ed25519
```

Use a separate SSH key for each device. Add the device's public key to
`~/.ssh/authorized_keys` on Tellico; never copy a private key between devices.

Confirm access before installing:

```bash
ssh tellico hostname
```

## Install

```bash
git clone https://github.com/Yejashi/tellico-agentic-setup.git
cd tellico-agentic-setup
./install.sh
```

For an SSH-authenticated GitHub checkout, use
`git@github.com:Yejashi/tellico-agentic-setup.git` instead.

If the SSH host or alias is not `tellico`:

```bash
./install.sh --ssh-host my-tellico-alias
```

To install the files without starting or testing the tunnel:

```bash
./install.sh --no-start
```

The installer is idempotent and can be rerun after pulling repository updates.

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
tellico-qwen-tunnel restart
tellico-qwen-tunnel cluster-status
tellico-qwen-tunnel stop
```

If the commands are not found immediately after installation, open a new
terminal or add this to the shell profile:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## What gets installed

```text
~/.config/tellico-qwen/client.env
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

## Allocation lifecycle

The two model servers exist only while the Tellico Slurm allocation is active.
Check it with:

```bash
tellico-qwen-tunnel cluster-status
```

When an allocation has expired, submit and wait for another one:

```bash
ssh tellico qwen38-submit
ssh tellico 'qwen38-status --wait'
tellico-qwen-tunnel restart
```

Using a custom SSH alias requires replacing `tellico` in the first two commands
or setting `TELLICO_SSH_HOST` for that shell.

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
remove OpenCode, SSH configuration, or any cluster files.

## Security model

- Both model forwards bind only to `127.0.0.1`.
- The model API key is fetched over SSH and stored with mode 0600.
- No API key is written into OpenCode JSON or the systemd unit.
- The repository contains no private credentials and can safely be cloned.
- Access still requires both Tellico SSH authorization and the cluster API key.
