# Tellico dashboard

How the models are doing and who is using them, live and over the last 30
days. It runs on the gateway host beside `tellico-gateway` and keeps history
that the terminal monitor (`tellico-gateway monitor`) does not.

## Install

On the gateway host:

```bash
dashboard/install-dashboard.sh     # installs and starts tellico-dashboard on 127.0.0.1:4101
tellico-dashboard status
```

It never restarts the gateway, the tunnel, the relay or the proxy.

## Use

It listens on loopback only and is **not** published through the reverse
proxy: it shows every user's activity and has no sign-in of its own, so ssh
is the lock. It refuses to start on any other address.

```bash
ssh <gateway host> tellico-dashboard report 24h     # 1h, 6h, 24h, 7d or 30d
ssh -L 4101:127.0.0.1:4101 <gateway host>           # then the JSON API below
```

The report shows each node (uptime, busy slots, throughput, speed while
working, cache hit rate, draft acceptance), each user (requests, errors,
rejections, tokens in / cached / out, latency p50 and p95, time to first
token, queueing), how replies ended, and the busiest hours of the week.

JSON, under `http://127.0.0.1:4101/monitor/api/`:

| Route | What |
|---|---|
| `live` | Both nodes now: slots and their context use, rates, model and build; gateway concurrency; the Slurm job and its time left |
| `history?range=24h` | Bucketed series per node, for the gateway and for requests, and tokens per user |
| `usage?range=24h` | Per-user totals and percentiles, reply endings, tokens per day, hour-of-week activity |
| `recent` | The last 100 requests and 20 rejections, and all-time totals |

## Where the numbers come from

- **llama.cpp's `/metrics`, `/slots` and `/props`** on each node, every 2 s.
  Ground truth for load, including tunnel users who never touch the gateway.
  A sample is stored every 10 s; rates are the increase of llama.cpp's own
  counters between samples, and a counter that goes down (a server restart)
  counts from zero.
- **The gateway's state file**, for per-user concurrency right now.
- **The gateway's journal**, one line per request. Since the gateway reads
  llama.cpp's closing `timings`, a line carries tokens read, reused from cache
  and generated, prompt and generation time, draft acceptance and how the
  reply ended -- streamed requests included. Older lines have none of that and
  count as requests only.
- **`squeue` over ssh**, every minute.

Per-user numbers cover gateway traffic only; the cluster cannot tell users
apart.

## Disk

The gateway host has a small disk. History is kept for 30 days, pruned hourly,
and the database is capped at 200 MB (oldest days go first); at today's
traffic it stays far below that. It lives in
`~/.config/tellico-dashboard/dashboard.db`.
