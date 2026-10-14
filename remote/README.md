# Tellico from a phone

The third way in. The tunnel gives you a terminal on your own machine and the
gateway gives other people an API key; this one gives *you* a browser — usually
a phone — that lists your sessions, streams them as they think, and lets you
steer them.

```bash
remote/install-remote.sh          # on the always-on host
tellico-remote caddy              # the proxy snippet, hash filled in
tellico-remote pair               # a one-time link; open it on the phone
```

It is one supervised `opencode-tellico serve` on loopback, with the same
agents, plugins, prompts and Magic Context as the TUI. The web app and the API
it serves are OpenCode's own — nothing here reimplements a client.

## Why it runs on the always-on host

Sessions belong to the process that runs them. A second server reading the same
storage sees the history and even the answer text as it is flushed, but gets no
events for it and reports it inactive, so a phone attached to one server cannot
watch a session that another started. Everything you want to see from the phone
therefore has to run where the phone can reach it.

That rules out a laptop as the host: it sleeps, and the endpoint flaps with it.
The gateway host is already always-on, already holds the cluster tunnel, and —
unlike the cluster's ppc64le login nodes — is ordinary x86_64 that OpenCode
ships binaries for. So the server lives beside the gateway, and reaches the
models through it over loopback:

```
phone ──HTTPS + password──► Caddy ──┬── /v1/*  ───► tellico-gateway ──┐
                                    │                                 │ 127.0.0.1:18080/18081
                                    └── /      ───► tellico-remote ───┘ (tellico-qwen-tunnel)
                                                    (opencode serve)
```

Going through the gateway rather than straight down the tunnel is deliberate:
remote sessions then queue, cap and log like every other user's, and show up in
`tellico-gateway monitor` under their own name.

The workspace is that host's filesystem, so this suits asking, planning,
reading and reviewing — not editing files that only exist on your laptop.

## Install

```bash
remote/install-remote.sh
```

Idempotent, and safe to rerun after `git pull`. It never restarts the tunnel or
the gateway, so a live session elsewhere keeps working while it runs.

```text
--port PORT          loopback port for the server (default: 4096)
--bind ADDR          address to listen on (default: 127.0.0.1)
--workspace DIR      directory sessions open in (default: ~/tellico-remote-work)
--connection MODE    gateway (default where one is installed) or tunnel
--gateway-url URL    base URL for --connection gateway (default: the local one)
--gateway-user NAME  gateway user whose key the server uses (default: remote)
--public-url URL     the https:// origin the proxy publishes
--rotate-password    replace the password; then re-paste the Caddy snippet
--no-start           install files only
```

Leave `--bind` on loopback. The proxy terminates TLS and asks for the password;
binding wider puts an endpoint that can run commands on the host onto the
network in the clear.

It needs the client install (`./install.sh`) for the launcher, and **OpenCode
2** — version 1 has no web app, no v2 API and no pairing.

## Publish it

The server is loopback-only until a reverse proxy fronts it. On a host that
already serves the gateway, both fit on one hostname, because `/v1/*` and the
web app do not overlap:

```bash
tellico-remote caddy     # prints the snippet with this host's hash in it
```

`remote/caddy/Caddyfile.example` is the whole file with the gateway and the web
app side by side. The web app cannot be moved under a path prefix: its manifest
scope, start URL and session cookie are all rooted at `/`.

## The phone

```bash
tellico-remote pair
```

Open the printed link on the phone within five minutes — it works once. The
proxy asks for the password first (user `opencode`,
`tellico-remote password`); the link then hands the browser a 30-day session
cookie, so the app itself never asks for anything. Use the browser's share menu
to add it to the home screen and it runs as a standalone app with its own icon.

Sessions you start there behave like any other Tellico session: the same
agents, the same `§N§` Magic Context recall, reasoning and text streaming in
at about a tenth of a second per update.

## Sharing sessions with your laptop

Sessions live wherever their server runs, so a session started on the phone is
not in your laptop's OpenCode storage. To work on the *same* sessions from
both, point the laptop's client at this server instead of its own:

```bash
opencode --server https://your.host.example
```

Tools then run on that host, in its workspace, not on your laptop — which is
the point when you want to pick a session up from the phone later, and the
wrong thing when you want to edit local files.

## Day to day

```bash
tellico-remote status      # service, endpoint, sessions, whether it is locked
tellico-remote doctor      # the whole path, loopback to public
tellico-remote logs -n 50
tellico-remote restart
```

`status` and `doctor` both check the public URL and say so loudly if it answers
without a password.

## Security

The server can run commands and edit files on its host, so the endpoint is as
sensitive as a shell there. Hence:

- **Two locks, one secret.** The proxy checks HTTP basic auth at the edge and
  OpenCode checks it again behind. One `Authorization` header satisfies both,
  so the phone types one password, and nothing unauthenticated reaches
  OpenCode at all.
- **The password is generated, never chosen.** Six words from a 35k-word pool
  is about 90 bits — strong enough for a public endpoint and still typeable on
  a phone. It is stored once, 0600, in `~/.config/tellico-remote/`, and reaches
  curl through a netrc file rather than argv so it never shows in a process
  listing. Caddy only ever holds its bcrypt hash.
- **Rotation:** `remote/install-remote.sh --rotate-password`, then re-paste
  `tellico-remote caddy` and pair the phone again.
- **Its own gateway key**, so remote sessions are capped and logged apart from
  your terminal's.
- **Nothing is logged that shouldn't be.** The Caddy log is JSON without the
  Authorization header; the server's journal holds no prompts.
