# Tellico agentic setup

Portable OpenCode client setup for the two Qwen3.8-27B servers running on the
Tellico cluster.

The repository contains no API key or SSH private key. The installer retrieves
the model API key through your authenticated Tellico SSH connection and stores
it only on the client device with mode 0600.

There are three ways to reach the models:

| | Who it is for | What the user needs |
|---|---|---|
| **Client, tunnel mode** (this README) | People with a cluster account | A Tellico account, an authorized SSH key, and this repository |
| **Client, gateway mode** (this README) | The same agentic setup, without a cluster account | A URL, an API key, and this repository |
| **Raw API** ([`gateway/`](gateway/README.md)) | Any OpenAI-compatible tool or script | A URL and an API key. Nothing installed |

The two client modes give an identical session: the same two node-pinned
workers, the same models, the same context. They differ only in how the
requests travel. Tunnel mode forwards the private cluster endpoints over your
own SSH connection. Gateway mode sends them to the API gateway instead, which
needs no SSH, no cluster account and no tunnel at all -- just the URL and key
whoever runs the gateway gave you.

The gateway itself runs on one always-on host in tunnel mode, so all three
paths share the same tunnel, cluster key and per-slot context.

## Architecture

| OpenCode provider | Cluster node | GPUs | Slots | Context per slot | Local endpoint |
|---|---|---:|---:|---:|---|
| `tellico-0/qwen3.8-27b` | `tellico-compute0` | 2 x V100 16 GB | 2 | 98,304 | `127.0.0.1:18080` |
| `tellico-1/qwen3.8-27b` | `tellico-compute1` | 2 x V100 16 GB | 2 | 98,304 | `127.0.0.1:18081` |

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

In gateway mode the local endpoints are replaced by the gateway's node-pinned
paths -- `https://HOST/v1/node0` and `.../node1` -- which route to the same two
servers. Everything else in the table, including the per-slot context, is
identical.

An SSH connection forwards the two private cluster endpoints to localhost.
OpenCode gets a primary orchestration agent and two node-pinned subagents. For
parallelizable work, the primary dispatches one bounded task to each server in
the same Task batch while keeping concurrent write scopes separate.

The cluster side of the service -- the Slurm job, the per-node llama.cpp server
and the commands that start and inspect them -- lives in
[qwen38-cluster](https://github.com/Yejashi/qwen38-cluster), and only the
service owner needs it. The two repositories share the API key path, the port,
the node names and the per-slot context, so a change to capacity on the cluster
means a matching change to `config/opencode.json` here.

## First run, gateway mode

If someone gave you a URL and an API key, this is the whole setup. You need
Linux, macOS, or WSL with `curl`, `sed`, `install`, and
[OpenCode](https://opencode.ai/docs/) on `PATH` -- no `ssh`, no VPN, no
cluster account.

```bash
git clone https://github.com/Yejashi/tellico-agentic-setup.git
cd tellico-agentic-setup
./install.sh --gateway-url https://HOST/v1
```

It asks for the key and stores it with mode 0600. Then:

```bash
opencode-tellico 0
```

To avoid the prompt, pass `--api-key-file PATH` or pipe the key in:

```bash
printf '%s' "$KEY" | ./install.sh --gateway-url https://HOST/v1
```

`./doctor.sh` knows which mode a device is in once installed. Before the first
install there is nothing recorded yet, so name the URL to be checked as a
gateway user:

```bash
./doctor.sh --gateway-url https://HOST/v1
```

The rest of this section is tunnel mode, which gateway mode does not need.

## First run, tunnel mode

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

4. **Add an SSH alias** to `~/.ssh/config`, if the device has none. `User` is
   your own Tellico account:

   ```sshconfig
   Host tellico
     HostName tellico.icl.utk.edu
     User YOUR_CLUSTER_ACCOUNT
     IdentityFile ~/.ssh/id_ed25519
   ```

   The account that owns the allocation is one person's account and not a
   shared login, so connect as it only if it is yours. `./doctor.sh` reports
   the account the alias resolves to, which is the one the next step
   authorizes against.

5. **Authorize this device.** Every device gets its own key; never copy a
   private key between machines. If this one has no key yet:

   ```bash
   ssh-keygen -t ed25519
   ```

   Then add its *public* key to `~/.ssh/authorized_keys` of the account from
   step 4, either with `ssh-copy-id -i ~/.ssh/id_ed25519.pub tellico` or by
   appending it from a machine that already has access. `./doctor.sh` prints
   this device's key and both commands, ready to paste, and names the account
   they apply to.

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
--gateway-url URL        Use gateway mode against this base URL, for example
                         https://host.example.ts.net/v1
--api-key-file PATH      File holding the gateway API key (gateway mode)
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

These notes are about holding the SSH tunnel open, so they apply to tunnel
mode only. Gateway mode has no tunnel and behaves the same everywhere.

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

`./doctor.sh` reads the mode this device was installed in and checks
accordingly, printing the one next step for the first thing that fails. It is
safe to run before installing. After installing, the same checks are available
as `tellico-qwen-tunnel doctor`.

In tunnel mode it checks tools, SSH config, network, device authorization, the
API key, the allocation, and tunnel health, in that order. In gateway mode
none of that applies, so it checks tools, the config, and one authenticated
probe of the gateway, which distinguishes an unreachable gateway from a
rejected key from a gateway with no model server behind it.

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

On a host that also runs the API gateway, `gateway/install-gateway.sh` adds:

```text
~/.config/tellico-gateway/gateway.env
~/.config/tellico-gateway/keys
~/.config/systemd/user/tellico-gateway.service
~/.local/lib/tellico-gateway/tellico_gateway.py
~/.local/bin/tellico-gateway
```

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

In gateway mode there is no cluster account to run `squeue` with, so
`tellico-qwen-tunnel status` reports what the gateway says instead: `models
no_allocation` means the gateway is healthy but has nothing behind it.

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

Gateway-mode devices need no such step: the gateway notices the new servers
within ten seconds by itself.

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

The uninstaller removes only files installed by this repository, including the
gateway if it is present. It does not remove OpenCode, SSH configuration, any
cluster files, a PATH line added by `--fix-path` (other tools in
`~/.local/bin` may depend on it), or the gateway's keys file, which holds
other people's credentials.

## Security model

- Both model forwards bind only to `127.0.0.1`.
- Gateway mode never holds the shared cluster key, never opens an SSH
  connection, and needs no cluster account; it holds one per-user API key,
  which the operator can revoke on its own.
- A gateway-mode device sends its key to whatever `--gateway-url` names, so
  that URL should be `https://`. The installer warns when it is not.
- The model API key is fetched over SSH and stored with mode 0600.
- No API key is written into OpenCode JSON or the systemd unit.
- The repository contains no private credentials and can safely be cloned.
- Access still requires both Tellico SSH authorization and the cluster API key.
- The API key is shared by every user of the OpenCode client, so it identifies
  the service rather than the caller. `llama-server --api-key-file` accepts one
  key per line, so moving to per-user keys is the way to get revocation and
  attribution. Users who come in through [`gateway/`](gateway/README.md) already
  get this: each holds only their own key, and the shared cluster key never
  leaves the gateway host.
