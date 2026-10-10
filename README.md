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
| `tellico-0/qwen3.8-27b-gsq-iq3s` | `tellico-compute0` | 2 x V100 16 GB | 2 | 131,072 | `127.0.0.1:18080` |
| `tellico-1/qwen3.8-27b-gsq-iq3s` | `tellico-compute1` | 2 x V100 16 GB | 2 | 131,072 | `127.0.0.1:18081` |

Each server divides one 262,144-token pool across two slots, so four
concurrent requests fit cluster-wide; beyond that, requests queue. A single
OpenCode session can issue several at once, because title, summary,
compaction, and subagent calls all go to the same two servers.

The model is Qwen3.8-27B in ISTA-DASLab's GSQ-RCO IQ3_S quantisation (11.8
GB, publisher-reported lossless on LiveCodeBench v6), with a DFlash2 draft
model for speculative decoding, chosen on 2026-10-09 for agentic coding at
128k. On a 12-task unit-tested coding suite it passed 11/12 against 4/12 for
the Qwen3.6-35B-A3B it replaced, and its tool calls held up where the 35B's
did not. Measured on one node: 72-86 tok/s for a lone request on code, 52-70
each with two running, about 33 tok/s for a session 64-110k tokens deep. Cold
prompt reading runs 430-650 tok/s, so a fresh 110k prompt waits about four
minutes; the prompt cache spares a returning session most of that.

Slots are not free in VRAM: a third 128k slot does not fit beside the drafter
(it does without it, at 24-34 tok/s each, which is slower for everyone). Speculation makes the model evaluate a block
of tokens per pass, so output is a valid sample but not byte-identical to a
non-speculative run. The trade is set on the cluster side in `service.env`
(`QWEN38_MODEL`, `QWEN38_CTX`, `QWEN38_SLOTS`, `QWEN38_SPEC_*`);
`limit.context` in `opencode.json` has to match the per-slot figure that
produces.

In gateway mode the local endpoints are replaced by the gateway's node-pinned
paths -- `https://HOST/v1/node0` and `.../node1` -- which route to the same two
servers. Everything else in the table, including the per-slot context, is
identical.

An SSH connection forwards the two private cluster endpoints to localhost.
OpenCode gets two primary agents per node and two node-pinned subagents:

| Agent | What it is |
|---|---|
| `orchestrate-tellico-0`, `orchestrate-tellico-1` | The default. Plans, delegates and integrates; dispatches one bounded task to each server in the same Task batch, keeping concurrent write scopes separate. Cannot run shell commands beyond read-only `git`. |
| `build-tellico-0`, `build-tellico-1` | One agent, one server, no delegation. Reads, edits and runs checks itself. Started with `--solo`. |
| `tellico-worker-0`, `tellico-worker-1` | Subagents the orchestrate lead dispatches to, one pinned to each node. |

`tab` switches between the primaries inside a session, so the choice at launch
is only where the session starts. See
[Orchestrate or solo](#orchestrate-or-solo).

The same two servers also back two more harnesses, both single-agent:
`pi-tellico` runs the [pi](https://pi.dev) coding agent and `crush-tellico`
runs [Crush](https://github.com/charmbracelet/crush). Each is the counterpart
of `opencode-tellico --solo` in its own harness. See
[The pi harness](#the-pi-harness) and
[The Crush harness](#the-crush-harness).

The cluster side of the service -- the Slurm job, the per-node llama.cpp server
and the commands that start and inspect them -- lives in
[qwen38-cluster](https://github.com/Yejashi/qwen38-cluster), and only the
service owner needs it. The two repositories share the API key path, the port,
the node names and the per-slot context, so a change to capacity on the cluster
means a matching change to `config/opencode.json` here.

## First run, gateway mode

If someone gave you an API key, that key is all you need. The gateway URL is
built into this repository. You need Linux, macOS, or WSL with `curl`, `sed`,
`install`, and [OpenCode](https://opencode.ai/docs/) on `PATH` -- no `ssh`, no
VPN, no cluster account.

```bash
git clone https://github.com/Yejashi/tellico-agentic-setup.git
cd tellico-agentic-setup
./install.sh
```

With no mode flag it asks which way you want in; choose **1) API key**, paste
the key when prompted, and that is the install. Then:

```bash
opencode-tellico 0
```

`./install.sh --gateway` skips the question. To avoid the key prompt too, pass
`--api-key-file PATH` or pipe the key in:

```bash
printf '%s' "$KEY" | ./install.sh --gateway
```

Rerunning `./install.sh` later keeps both the mode and the key, so an update
after `git pull` asks nothing. Pass `--api-key-file` to replace the key, or
`--gateway-url URL` to point at a different gateway.

`./doctor.sh` knows which mode a device is in once installed. Before the first
install there is nothing recorded yet, so say which mode to check:

```bash
./doctor.sh --gateway
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

With no mode flag, an interactive run asks which mode to install, defaulting
to the mode already recorded on the device.

```text
--gateway                Gateway mode against the built-in URL
--ssh, --tunnel          Tunnel mode over your own SSH connection
--gateway-url URL        Gateway mode against a different base URL, for
                         example https://host.example.ts.net/v1
--api-key-file PATH      File holding the gateway API key. Without it the key
                         is piped in, typed, or kept from a previous install.
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

Three commands start a session: `opencode-tellico` for the OpenCode harness
with its lead and two workers, and `pi-tellico` and `crush-tellico` for the
single-agent [pi](#the-pi-harness) and [Crush](#the-crush-harness) harnesses.
All three share the tunnel, the key and the two servers.

Start a dual-node OpenCode session with the lead on node 0:

```bash
opencode-tellico 0
```

Or put the lead on node 1:

```bash
opencode-tellico 1
```

Both commands can use both node-pinned subagents. The number only chooses the
model that hosts the lightweight lead conversation. For a single agent that
does the work itself instead of delegating, add `--solo`; see
[Orchestrate or solo](#orchestrate-or-solo).

With no number, the lead node is derived from the device, so that several users
do not all lead on node 0 and compete for one server's prompt cache. It is
stable for a given device, which keeps that cache warm across sessions;
`TELLICO_LEAD_NODE=0` or `=1` overrides it.

Why it matters: the servers run a 91% prompt-cache hit rate, and a miss on a
large agentic context costs minutes of reprocessing. Spreading the leads is
free and protects it. See
[`docs/flash-next-evaluation.md`](docs/flash-next-evaluation.md) for why the
window cannot simply be made bigger instead.

### Orchestrate or solo

The default agent plans and delegates. It keeps its own window clear by
spending a worker's instead, which is what makes a long task survive on a
128k model, and it runs two servers at once on work that splits. It is also
the slower, more indirect way to change three lines.

`--solo` opens on `build-tellico` instead: one agent, one server, doing the
reading and editing and checking itself.

```bash
opencode-tellico 0 --solo
TELLICO_SOLO=1 opencode-tellico        # same thing, as an environment variable
```

Reach for `--solo` when the task does not split into independent units, when
you want to watch exactly what is happening, or when delegation would cost
more round trips than it saves. Reach for the default on anything broad enough
to have two independent halves, or long enough that the lead's context would
otherwise fill.

Both are always defined, for both nodes, so `tab` switches between them
mid-session and the flag only chooses where the session starts. The difference
in what they may do is deliberate: the orchestrate lead cannot run shell
commands beyond read-only `git`, because its job is to delegate them;
`build-tellico` has full `bash` and `edit` and cannot dispatch at all. Neither
can read the API key, `client.env` or an SSH private key -- that is blocked at
the tool layer for every agent -- and both still ask before touching anything
outside the working directory.

### Watching the workers

The sidebar lists the session's subagents -- which worker, what it was asked,
and whether it is still running -- and clicking one opens its session so you
can follow its progress.
OpenCode 2 hides the sidebar until you press `ctrl+x b` (or run "Show
sidebar" from `ctrl+p`). On OpenCode 1 the panel is the vendored
`subagent-watch`; on OpenCode 2 it is `plugins/tui-v2/subagents`.

### Controlling how much it thinks

The model is a reasoning model, and how much it reasons is a model variant.
Four levels exist, which are what the chat template accepts:

| Level | Meaning |
|---|---|
| `off` | no reasoning at all; fastest, for mechanical edits |
| `low` | brief reasoning |
| `medium` | the default here, for the lead and both workers |
| `xhigh` | the most the template allows |

`medium` is the default because it is the level this setup is tuned around,
and it is now stated in `config/opencode.json` rather than inherited: the
cluster happens to start `llama-server` with `--reasoning-effort medium` too,
but the client no longer depends on that, and the template's own default is
`xhigh`. Change `agent.*.variant` there to move the default.

There are three ways to change it, from widest to narrowest scope.

For a whole session, at launch:

```bash
opencode-tellico 0 --think low
TELLICO_THINK=off opencode-tellico 1      # same thing, as an environment variable
```

Inside a running session, with OpenCode's own variant controls:

```text
ctrl+t      cycle the level
ctrl+x t    list the levels and pick one
```

For one request:

```text
/think-off    fix the import order in this file
/think-xhigh  why does this lock order deadlock under two writers?
```

`--think` and the config default apply to the lead and both workers. `ctrl+t`
changes the session's model variant, which is the lead's: a worker dispatched
afterwards still runs at the level the session was launched with, so reach for
`--think` when you want the whole fleet moved. `ctrl+x t` is this setup's
binding (`config/tui.json`) and is OpenCode 1 only; `ctrl+t` is built in and
works on both.

Title, summary and compaction never think at all, whatever you ask for: they
are the session's own overhead rather than work you asked for, and a summary
that spends its output budget on reasoning comes back truncated, which ends
the session (see [Compaction](#compaction)).

Non-interactive example:

```bash
opencode-tellico 0 run 'Review this repository and fix the highest-impact issue'
opencode-tellico 0 --think off run 'Rename this symbol across the repository'
```

### Compaction

A session that fills its 128k window is compacted: OpenCode summarises the old
turns and continues from the summary. That is routine, but on this setup it had
two ways to fail, and a failed compaction is terminal -- OpenCode stops the
turn, and every turn after it retries the same compaction and stops again, so
the session is finished mid-task.

Both are closed now:

- **The summary ran out of output budget.** Compaction inherited the session's
  thinking level -- the compaction messages in this device's history are
  recorded with `variant: xhigh` -- so the model reasoned at length and the
  summary itself could be cut off. Measured across 193 compactions on this
  device, summaries run 600-7,400 output tokens with thinking on, median 3,215,
  and the thinking is all of the variance. OpenCode 1.18.30's own compaction
  allows 32,000, so there was margin here; its newer compaction path hard-caps
  the summary at 4,096, which 17% of those 193 exceeded. Compaction, summary
  and title now never think (`plugins/compaction-guard/`, plus
  `agent.compaction.options` in `config/opencode.json`), which removes the
  variance instead of relying on the margin.

- **The compaction request was itself too big for the window.** Compaction
  renders the whole conversation so far into one prompt, reasoning blocks
  included, and reasoning is the bulk of it -- 74% of a 115,562-token payload in
  the one session on this device where compaction failed outright.
  `compaction.reserved` is meant to make compaction fire early enough to leave
  room, but OpenCode only honours it when the model also declares
  `limit.input`, which is why each model here now declares it. Compaction
  fires at 131,072 - 40,000 = 91,072 tokens, leaving the whole 32,000-token
  output allowance plus slack for one more turn.

If it ever does fail, the session cannot be rescued: start a new one. Nothing
is lost from disk, only the conversation.

### The pi harness

`pi-tellico` runs [pi](https://pi.dev) against the same two servers. Install pi
first -- `curl -fsSL https://pi.dev/install.sh | sh`, or `npm install -g
--ignore-scripts @earendil-works/pi-coding-agent`; it needs Node 22.19 or newer
-- then:

```bash
pi-tellico                       # node derived from this device, as above
pi-tellico 0 --think off
pi-tellico 0 'Review this repository'
pi-tellico 0 --print 'What does install.sh install?'
pi-tellico --continue            # pi's own flags are passed through
```

Pi is a deliberately small harness: four core tools, no subagents, no plan
mode. So there is no orchestrate-or-worker choice here -- one agent, one
server, which is the same shape as `opencode-tellico --solo`. Use it when you
want a harness that does less, and `opencode-tellico` when you want two
servers working at once.

What it gets from this setup:

| Piece | Why |
|---|---|
| `pi/models.json` | Both nodes as `openai-completions` providers, 131,072 context and 32,768 output, and the `chat_template_kwargs` channel that actually reaches the Qwen template. The API key is named as a command, so the file holds no secret. |
| `pi/settings.json` | Medium thinking, `grep`/`find`/`ls` added to pi's four default tools, and compaction reserve raised so a summary gets the model's whole output allowance. Prompt-cache warming is off: four slots serve every user, so a warming request is a slot taken from someone's real work. |
| `pi/APPEND_SYSTEM.md` | Appended to pi's own system prompt: the context economy, `.agent/PLANS.md` as the thing that survives compaction, and the verification and credential rules. |
| `pi/extensions/secret-guard/` | Blocks reads of the API key, `client.env` and SSH private keys. Pi has no permission system -- it "does not ask for approval before every tool call" -- so this is the only thing between the model and the credential. |

Thinking works the same way, with pi's own controls: the config defaults to
medium, `--think` sets the session, `/thinking` changes it inside one, and
`ctrl+t` cycles. Pi has seven levels but the Qwen3.8 template accepts only
`low`, `medium` and `xhigh`, so the rest are marked unsupported and never
reach it -- asking for `high` clamps to `xhigh` rather than being rejected by
the template.

Its configuration is kept apart from your own `~/.pi/agent` in both
directions: a Tellico session is not changed by your personal pi settings, and
installing or removing this setup never touches them. The cost is that your own
pi extensions, skills and prompts are not loaded; add them to
`~/.config/tellico-qwen/pi/`, or name them with pi's `--extension`, `--skill`
and `--prompt-template` flags, which are passed through. Sessions are kept
outside the configuration directory, in
`~/.local/share/tellico-qwen/pi-sessions`, so uninstalling never deletes a
transcript.

### The Crush harness

`crush-tellico` runs [Crush](https://github.com/charmbracelet/crush) against
the same two servers. Install Crush first (Homebrew, npm, Arch, Nix and more
in its README), then:

```bash
crush-tellico                    # node derived from this device, as above
crush-tellico 0 --think off
crush-tellico 0 run 'Review this repository'
crush-tellico 0 --continue       # Crush's own flags are passed through
```

Crush is single-agent here too: its subagent support is an open pull request,
so this is its counterpart of `--solo`. What it adds over OpenCode and pi is a
permission prompt in front of every tool call, `PreToolUse` hooks, and LSP
integration, in a single Go binary with no Node dependency.

It is configured differently from the other two, and not by choice. Crush
merges `./.crushrc`, `./crushrc` and `$XDG_CONFIG_HOME/crush/crushrc` and has
no config flag or environment variable; relocating that search with
`XDG_CONFIG_HOME` would also redirect every command the model runs through the
`bash` tool. So this setup integrates instead of isolating: `install.sh` writes
`~/.config/tellico-qwen/crush/tellico.crushrc` and appends **one marked line**
to your own `~/.config/crush/crushrc` that sources it. `./uninstall.sh` takes
that line back out, and `./doctor.sh` has a `crushrc` line that tells you if it
is missing. Nothing in the fragment touches a setting that is not about
Tellico -- no global permission changes, no provider defaults -- because it
runs inside a file you own.

Because `crushrc` is Bash, the launcher passes the node and the thinking level
through `TELLICO_LEAD_NODE` and `TELLICO_THINK`, which the fragment reads.
Crush has no flag that picks a model for an interactive session, so this is the
whole mechanism; `crush run` does accept `-m`, if you want to override it for
one command.

Four providers are registered, which is two more than the other harnesses
need:

| Provider | Why |
|---|---|
| `tellico-0`, `tellico-1` | One per node, carrying the session's thinking level in `extra_body` as `chat_template_kwargs`. |
| `tellico-0-quiet`, `tellico-1-quiet` | The same servers with thinking off. These hold Crush's *small model* slot, which it uses for titles and for auto-summarize. A summary that spends its output budget on reasoning comes back truncated -- the failure this setup already paid for once under OpenCode -- so here it simply cannot think. |

Two settings are worth knowing about. The models are deliberately **not**
marked `--can-reason`: Crush's own `--reasoning-effort` offers `high`, which
the Qwen3.8 template rejects outright, so the level travels in `extra_body`
instead and Crush never adds one of its own. And `request-timeout` is raised to
3600 from its default of 60 -- Crush aborts on that many seconds of
inactivity, and a cold 110k-token prompt on this cluster waits about four
minutes before the first token, so every deep session would otherwise die.

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
~/.config/tellico-qwen/prompts/build.md
~/.config/tellico-qwen/plugins/
~/.config/tellico-qwen/pi/
~/.config/tellico-qwen/crush/
~/.config/tellico-qwen/api-key
~/.local/bin/opencode-tellico
~/.local/bin/pi-tellico
~/.local/bin/crush-tellico
~/.local/bin/tellico-qwen-tunnel
```

Plus one marked line in `~/.config/crush/crushrc`, which is the only file this
setup writes outside its own directory; `./uninstall.sh` removes it again.

`pi/` is the whole configuration for the pi harness -- `models.json`,
`settings.json`, `APPEND_SYSTEM.md` and `extensions/` -- and
`PI_CODING_AGENT_DIR` points pi at it. Pi sessions go to
`~/.local/share/tellico-qwen/pi-sessions` instead, so uninstalling does not
delete them.

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
~/.local/lib/tellico-gateway/tellico_monitor.py
~/.local/bin/tellico-gateway
```

`tellico-gateway monitor` on that host shows who is using the models, how much
of the cluster is busy, and whether anything is queueing -- including sessions
that come down an SSH tunnel instead of through the gateway. See
[`gateway/README.md`](gateway/README.md#watching-usage-and-load).

OpenCode loads `opencode.json` through its supported `OPENCODE_CONFIG` merge
layer, so the device's normal providers and settings remain available. Runtime
overrides pin title, summary, compaction, lead, and worker calls to Tellico for
the launched session.

OpenCode v2 serves plain `opencode` invocations from a shared background
service that was started without `OPENCODE_CONFIG`, which makes it ignore that
variable and report `Model unavailable: tellico-0/qwen3.8-27b-gsq-iq3s`. So
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
