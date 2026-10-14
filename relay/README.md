# Tellico on your phone

Sign in with your own gateway API key and see every Tellico session you have
running — on your laptop, in VS Code, in a terminal on another machine — live,
as it thinks and writes. Send any of them a prompt, or stop one, from wherever
you are.

```
https://<gateway host>/tellico/
```

Add it to the home screen (share menu → *Add to Home Screen*) and it runs as an
app with its own icon.

## Turn it on for a computer

Remote control is **off** until you turn it on, per device:

```bash
./install.sh --no-start --remote-control
```

From then on every `opencode-tellico` you start there — the TUI, `serve`, and
the VS Code extension's windows — shows up on your phone. Sessions that were
already running keep going untouched; they appear once started again.

For a single launch: `opencode-tellico --remote-control` or
`--no-remote-control`. `./install.sh --no-start --no-remote-control` turns it
off for the device.

It signs in with your **gateway** key. A gateway install already has one; a
tunnel install needs one in `~/.config/tellico-qwen/api-key.gateway` (mode
600). Without a key the session still starts, just without remote control.

## How it works

```
your laptop                               gateway host                 your phone
 opencode-tellico ─┐                    ┌──────────────┐
  + remote-control │── publish (HTTPS) ─►│ tellico-relay │◄── sign in, live view ── browser
    plugin         │◄── poll for prompt ─│  /tellico/    │─── prompt / stop ──────►
                   └ runs it locally     └──────────────┘
```

- **The plugin** (`plugins/remote-control`) runs inside each OpenCode process.
  It watches the session event stream from the inside, sends a session's
  history the first time it sees it, then every token as it streams. It also
  long-polls the relay for commands.
- **The relay** (`relay/tellico_relay.py`) keeps each user's sessions in
  memory and streams them to that user's phone. It is standard-library
  Python, like the gateway.
- **The phone app** (`relay/web`) is plain HTML, CSS and JavaScript with no
  build step.

Both directions are requests the laptop makes **out**. No port on your
machine is opened or forwarded, and the relay cannot reach it.

## What a phone can do

Exactly two things, for your own sessions only:

- **Prompt** a session. While it is working the message steers it; it is
  delivered after the current step, as if typed at the computer.
- **Stop** it.

The plugin refuses anything else, and anything for a session its own process
is not running. It never reads files, opens a shell or changes config for the
relay. The agents do what they would have done had you typed the prompt
yourself, with the same permissions.

Two things it does not do. Workers take instructions from their lead, so a
worker can be watched but not prompted. And a `question` the agent asks is
shown, but has to be answered at the computer.

## Security

- **Your gateway key is your identity.** The relay reads the gateway's own
  keys file, so `tellico-gateway revoke` signs out that user's phones and
  disconnects their machines within a second. Users only ever see their own
  sessions.
- **The phone never stores the key.** It is exchanged once for a 30-day
  sign-in cookie (`HttpOnly`, `Secure`, `SameSite=Strict`). The relay stores
  only hashes of sign-ins.
- **The plugin refuses plain HTTP** to anything but loopback, so the key never
  crosses a network in the clear.
- **The page cannot run injected markup.** It has a strict Content Security
  Policy and builds every transcript out of text nodes, so model or tool output
  cannot inject markup.
- **Repeated wrong keys are rate limited.**
- **The relay's log** records sign-ins, machines coming and going, and that a
  command was sent, never what a session says.

Turning remote control on means a stolen gateway key could prompt your agents,
not just call the model. That is why it is opt-in per device. Revoke a leaked
key with the gateway.

## Running the relay

On the gateway host:

```bash
relay/install-relay.sh            # installs and starts tellico-relay on 127.0.0.1:4100
tellico-relay status
tellico-relay logs -f
```

Then route `/tellico/` to it in Caddy, above any catch-all.
`remote/caddy/Caddyfile.example` has the whole file:

```
@relay path /tellico /tellico/*
handle @relay {
	reverse_proxy 127.0.0.1:4100 {
		flush_interval -1
	}
}
```

Restarting the relay interrupts no one. It keeps no transcripts on disk; each
connected plugin notices the restart and resends its sessions within seconds.
Sign-ins survive, so phones stay signed in.

The icons are generated: `python3 relay/make_icons.py`.
