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
   ssh tellico qwen38-submit
   ssh tellico 'qwen38-status --wait'
   tellico-qwen-tunnel restart
   ```

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
remove OpenCode, SSH configuration, any cluster files, or a PATH line added by
`--fix-path`, since other tools in `~/.local/bin` may depend on it.

## Security model

- Both model forwards bind only to `127.0.0.1`.
- The model API key is fetched over SSH and stored with mode 0600.
- No API key is written into OpenCode JSON or the systemd unit.
- The repository contains no private credentials and can safely be cloned.
- Access still requires both Tellico SSH authorization and the cluster API key.
