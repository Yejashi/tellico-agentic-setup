# Tellico API gateway

The second way in. Instead of installing this repository, holding an SSH key on
Tellico and running a tunnel, a user gets a URL and their own API key:

```bash
curl https://lab-pc.tail960ade.ts.net/v1/chat/completions \
  -H "Authorization: Bearer sk-tellico-..." \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen3.8-27b","messages":[{"role":"user","content":"hello"}]}'
```

It is one process on **one** host you control. That host still runs
`tellico-qwen-tunnel` exactly as before; the gateway reuses its forwards and
its cluster key, and never restarts it.

```
5 users ──HTTPS + per-user key──► gateway host
                                    │  tellico-gateway: keys, admission, routing
                                    │  tellico-qwen-tunnel: ssh -L 18080/18081
                                    ▼
                           tellico-compute0/1:8000
```

## Why it is not on the cluster

Tellico's login and compute nodes are ppc64le on RHEL 7.6 with `go1.18`, no
root, no user systemd and no lingering, and the login node is a public IP
behind a firewall nobody here can edit. Tailscale and cloudflared ship no
ppc64le builds and need a newer Go, nothing started on a login node survives
logout, and opening an inbound port would need an administrator *and* would
expose the endpoint to the whole internet rather than to five people.

So the exposure lives on your host, where the arch is ordinary and the
decisions are yours. Nothing about the cluster side changes.

## Host requirements

- `python3` (3.8+), `curl`, `awk`. The gateway is standard library only, so
  there is no virtualenv and nothing to keep upgraded.
- The client side of this repository already installed and its tunnel up:
  `./install.sh`, then `tellico-qwen-tunnel status`.
- Always on. A laptop that sleeps makes the endpoint flap for everyone.
- systemd user manager, for the unit and auto-restart. Without one the gateway
  still runs via `tellico-gateway run` under your own supervisor.

## Install

```bash
./gateway/install-gateway.sh
```

Idempotent, and safe to rerun after `git pull`. It never touches the SSH
tunnel, so a live `opencode-tellico` session keeps working while it runs.

```text
--bind ADDR        address to listen on (default: 127.0.0.1)
--port PORT        port to listen on (default: 4000)
--max-inflight N   cluster slots the gateway may hold at once (default: 3)
--no-start         install files only
```

Leave `--bind` at `127.0.0.1`. Funnel and Caddy both connect over loopback,
and binding wider puts an unencrypted endpoint on your LAN.

## Hand out a key

```bash
tellico-gateway add-user alice          # default: 1 request at a time
tellico-gateway add-user bob 2          # let bob hold two slots
tellico-gateway list-users
tellico-gateway revoke alice
```

The key is printed once and never stored: the keys file keeps only a SHA-256
hash, so a copy of it cannot be replayed against the gateway. Add and revoke
take effect within a second, with no restart — the gateway reloads the file
when its mtime changes.

Give users [CLIENTS.md](CLIENTS.md); it is written to be forwarded as-is.

## Publish it

```bash
tellico-gateway expose      # Tailscale Funnel: real TLS, no open ports, free
tellico-gateway url         # the base URL to send people
tellico-gateway unexpose
```

Funnel needs two one-time settings in the tailnet admin console, which
`expose` prints if they are missing: **DNS → HTTPS Certificates → Enable**, and
the **`funnel` node attribute** for this host in Access controls.

Prefer a custom domain, or need the endpoint to outlive your tailnet? Put the
whole thing on a small VPS and use
[caddy/Caddyfile.example](caddy/Caddyfile.example) instead; the VPS holds the
SSH tunnel itself and the design is otherwise identical.

## Operate it

```bash
tellico-gateway status     # service, both nodes, in-flight, public URL, users
tellico-gateway doctor     # python, cluster key, tunnel, keys, service, funnel
tellico-gateway logs       # one line per request
tellico-gateway restart
```

One request, one line, no keys:

```text
user=alice model=qwen3.8-27b node=node0 status=200 queued=1.0s dur=0.9s stream=0 in=19 out=12
```

`queued` is the time spent waiting for a slot. If it is routinely seconds,
the cluster is the bottleneck, not the gateway.

## Concurrency is the real limit

Tellico serves about **four concurrent requests cluster-wide** (2 nodes x 2
slots). That, not the transport, is what five users will notice.

`--max-inflight 3` is therefore the default: the gateway holds at most three
slots, leaving one for a direct `opencode-tellico` session so your own lead
agent is never stuck behind a stranger's long completion. Per user the default
is one request at a time, which keeps any single caller from occupying the
whole gateway budget.

A caller that cannot get a slot within `TELLICO_GATEWAY_QUEUE_TIMEOUT`
(120s) gets `429` with `Retry-After`. When no node is reachable at all —
normally because the Slurm allocation ended — it gets `503` immediately,
naming the allocation, rather than waiting out the queue.

## Models

| Model id | Routes to |
|---|---|
| `qwen3.8-27b` | either node, whichever has fewer requests in flight |
| `qwen3.8-27b-node0` | `tellico-compute0` only |
| `qwen3.8-27b-node1` | `tellico-compute1` only |

Use the pooled name unless the caller is driving both nodes itself, the way
`opencode-tellico`'s lead and workers do.

A node can also be pinned by base URL instead of by model name:

| Base URL | Routes to |
|---|---|
| `https://HOST/v1` | either node |
| `https://HOST/v1/node0` | `tellico-compute0` only |
| `https://HOST/v1/node1` | `tellico-compute1` only |

Both paths serve the same model id, which is what a client with one base URL
per provider needs. If a URL and a model name disagree, the request is
refused rather than quietly sent somewhere.

## Giving someone the full OpenCode setup

A gateway key is enough to run `opencode-tellico` itself -- the dual-node lead
with both node-pinned workers -- with no SSH and no cluster account. Send the
person the repository, the base URL and their key; they run:

```bash
./install.sh --gateway-url https://HOST/v1
opencode-tellico 0
```

That is why the node paths above exist. The installer points provider
`tellico-0` at `/v1/node0` and `tellico-1` at `/v1/node1`, so the agents,
model ids and per-slot context are identical to a tunnel-mode device and
nothing else in the config changes.

Such a session opens several requests at once (lead, title, summary,
compaction, workers), so give an opencode user more than one slot or they will
serialize against themselves:

```bash
tellico-gateway add-user dana 3
```

With `--max-inflight 3`, one user at 3 can saturate the gateway's whole
budget. That is a deliberate trade: an agentic session wants parallelism, a
scripted caller does not.

## Settings

`~/.config/tellico-gateway/gateway.env`, written by the installer. Edit, then
`tellico-gateway restart`.

| Variable | Default | Meaning |
|---|---|---|
| `TELLICO_GATEWAY_BIND` | `127.0.0.1` | Listen address |
| `TELLICO_GATEWAY_PORT` | `4000` | Listen port |
| `TELLICO_GATEWAY_NODES` | both tunnel ports | `label=host:port` per node |
| `TELLICO_GATEWAY_MAX_INFLIGHT` | `3` | Cluster slots the gateway may hold |
| `TELLICO_GATEWAY_DEFAULT_MAX_PARALLEL` | `1` | Per-user default, overridden per key |
| `TELLICO_GATEWAY_QUEUE_TIMEOUT` | `120` | Seconds to wait for a slot before `429` |
| `TELLICO_GATEWAY_REQUEST_TIMEOUT` | `3600` | Upstream timeout, for long generations |
| `TELLICO_GATEWAY_MODEL` | `qwen3.8-27b` | Base model id |
| `TELLICO_GATEWAY_CONTEXT` | from `opencode.json` | Context advertised on `/v1/models` |

`TELLICO_GATEWAY_CONTEXT` is read from `config/opencode.json` at install time,
so it follows the per-slot context coupling described in `AGENTS.md`. When the
cluster's `QWEN38_CTX` or `QWEN38_SLOTS` changes, rerun the installer.

## Security model

- The cluster API key never leaves the gateway host. Users hold only their own
  key, so today's situation — every user holding the shared service key — ends
  for anyone who comes in this way.
- User keys are stored as SHA-256 hashes, compared in constant time.
- Revocation and attribution are per user, which the shared key cannot do.
- The gateway binds loopback; TLS is Funnel's or Caddy's job.
- `gateway.env` holds no secrets. The keys file and the cluster key are 0600.
- Funnel makes the endpoint reachable by the entire internet, where only a
  valid key keeps strangers out. Mint one key per person, never one shared key,
  and watch `tellico-gateway logs` for 401s after you publish.
- Fronting ICL compute with a public endpoint is worth clearing with whoever
  administers Tellico. This design keeps the exposed surface on your host
  rather than theirs, which should make that an easy conversation.

## If you later want a dashboard

LiteLLM is the natural upgrade: spend tracking, budgets, a UI. Its virtual
keys need a Postgres database, which is a lot of moving parts for five users
and cannot express "leave one slot for opencode", so it is not the starting
point. The wire protocol here is plain OpenAI `/v1`, so swapping later costs
your users nothing but a base URL.
