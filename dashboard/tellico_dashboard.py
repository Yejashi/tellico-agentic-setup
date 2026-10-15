#!/usr/bin/env python3
"""Tellico dashboard: how the models are doing and who is using them.

Runs on the gateway host and serves an admin-only page under /monitor/. It
reads the same sources as `tellico-gateway monitor`:

  * each llama.cpp server's /metrics, /slots and /props (ground truth for
    load, including tunnel users who never touch the gateway);
  * the gateway's state file (per-user concurrency right now);
  * the gateway's journal (one line per request, with token counts);
  * squeue over ssh (the Slurm job and its remaining walltime).

Unlike the terminal monitor it keeps history, in SQLite, for RETENTION_DAYS.
The gateway host has a small disk, so samples are coarse (SAMPLE_EVERY) and
the database is pruned hourly and capped at MAX_DB_BYTES.

The page shows every user's activity and the hostname is public, so it has
no access control of its own and must only ever be reached through the
reverse proxy, which asks for the operator's password first (see README.md).
It listens on loopback, and refuses to start on anything else.

Standard library only, like the gateway and the relay.
"""

import http.client
import json
import mimetypes
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

PREFIX = "/monitor"

LIVE_EVERY = 2.0
SAMPLE_EVERY = 10.0
JOURNAL_EVERY = 15.0
SLURM_EVERY = 60.0
PROPS_EVERY = 300.0
PRUNE_EVERY = 3600.0
RETENTION_DAYS = 30
MAX_DB_BYTES = 200 * 1024 * 1024

WEB_FILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}


def log(message):
    sys.stdout.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), message))
    sys.stdout.flush()


def _env(name, default):
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def read_shell_env(path):
    values = {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                values[key.strip()] = value.strip().strip("'\"")
    except OSError:
        pass
    return values


class Config:
    def __init__(self):
        home = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
        gateway = read_shell_env(os.path.join(home, "tellico-gateway/gateway.env"))
        client = read_shell_env(os.path.join(home, "tellico-qwen/client.env"))
        self.bind = _env("TELLICO_DASHBOARD_BIND", "127.0.0.1")
        self.port = int(_env("TELLICO_DASHBOARD_PORT", "4101"))
        self.state_dir = _env("TELLICO_DASHBOARD_STATE_DIR", os.path.join(home, "tellico-dashboard"))
        self.db_path = _env("TELLICO_DASHBOARD_DB", os.path.join(self.state_dir, "dashboard.db"))
        self.web_dir = _env("TELLICO_DASHBOARD_WEB",
                            os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))
        self.collect = os.environ.get("TELLICO_DASHBOARD_COLLECT", "1") != "0"
        self.key_file = os.path.expanduser(
            gateway.get("TELLICO_GATEWAY_UPSTREAM_KEY") or os.path.join(home, "tellico-qwen/api-key"))
        self.max_inflight = int(gateway.get("TELLICO_GATEWAY_MAX_INFLIGHT") or 0)
        spec = _env("TELLICO_DASHBOARD_NODES", gateway.get("TELLICO_GATEWAY_NODES") or "")
        if not spec:
            spec = "node0=127.0.0.1:%s node1=127.0.0.1:%s" % (
                client.get("TELLICO_QWEN_PORT0") or "18080", client.get("TELLICO_QWEN_PORT1") or "18081")
        self.nodes = []
        for item in spec.split():
            label, _, address = item.partition("=")
            host, _, port = address.rpartition(":")
            if label and host and port.isdigit():
                self.nodes.append((label, host, int(port)))
        runtime = gateway.get("TELLICO_GATEWAY_RUNTIME") or os.path.join(
            os.environ.get("XDG_RUNTIME_DIR") or os.path.expanduser("~/.cache"), "tellico-gateway")
        self.gateway_state = _env("TELLICO_DASHBOARD_GATEWAY_STATE",
                                  os.path.join(os.path.expanduser(runtime), "state.json"))
        self.gateway_unit = _env("TELLICO_DASHBOARD_GATEWAY_UNIT", "tellico-gateway.service")
        self.ssh_host = client.get("TELLICO_SSH_HOST") or "tellico"
        self.service_user = _env("TELLICO_SERVICE_USER", "bbogale")
        self.job_name = _env("TELLICO_JOB_NAME", "qwen38-api")

    def upstream_key(self):
        try:
            with open(self.key_file, "r", encoding="utf-8") as handle:
                return handle.read().strip() or None
        except OSError:
            return None


SCHEMA = """
CREATE TABLE IF NOT EXISTS samples (
  ts REAL NOT NULL, node TEXT NOT NULL, up INTEGER NOT NULL,
  busy INTEGER, slots INTEGER, deferred INTEGER, used INTEGER, secs REAL,
  d_prompt INTEGER, d_cached INTEGER, d_gen INTEGER,
  d_prompt_s REAL, d_gen_s REAL, d_draft INTEGER, d_acc INTEGER
);
CREATE INDEX IF NOT EXISTS samples_ts ON samples(ts);
CREATE TABLE IF NOT EXISTS gateway (
  ts REAL NOT NULL, inflight INTEGER, max INTEGER, waiting INTEGER, workers INTEGER
);
CREATE INDEX IF NOT EXISTS gateway_ts ON gateway(ts);
CREATE TABLE IF NOT EXISTS requests (
  ts REAL NOT NULL, user TEXT, node TEXT, role TEXT, status INTEGER,
  queued REAL, dur REAL, stream INTEGER, prompt INTEGER, completion INTEGER,
  cache INTEGER, pms INTEGER, gms INTEGER, draft INTEGER, acc INTEGER,
  finish TEXT, gone INTEGER
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE TABLE IF NOT EXISTS rejections (ts REAL NOT NULL, user TEXT, why TEXT);
CREATE INDEX IF NOT EXISTS rejections_ts ON rejections(ts);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""


def connect(path):
    db = sqlite3.connect(path, timeout=30, check_same_thread=False)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=NORMAL")
    db.executescript(SCHEMA)
    return db


REQUEST_LINE = re.compile(
    r"user=(?P<user>\S+)\s+model=\S+\s+node=(?P<node>\S+)\s+status=(?P<status>\d+)\s+"
    r"queued=(?P<queued>[\d.]+)s\s+dur=(?P<dur>[\d.]+)s\s+stream=(?P<stream>\d)\s+"
    r"in=(?P<prompt>\S+)\s+out=(?P<completion>\S+)(?P<rest>.*)$"
)
EXTRA = re.compile(r"\b(role|cache|pms|gms|draft|acc|finish|gone)=(\S+)")
REJECT_LINE = re.compile(r"user=(?P<user>\S+)\s+model=\S+\s+rejected:\s+(?P<why>.+)$")


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_line(message):
    """("request", row) or ("rejection", row) or None, for one gateway line.

    Lines from before the gateway read llama.cpp's timings have no fields
    after out=, and streamed ones have "-" there; those come back as None.
    """
    match = REQUEST_LINE.search(message)
    if match:
        extra = dict(EXTRA.findall(match.group("rest")))
        finish = extra.get("finish")
        return "request", {
            "user": match.group("user")[:64],
            "node": match.group("node")[:32],
            "role": extra.get("role") if extra.get("role") in ("lead", "worker") else None,
            "status": int(match.group("status")),
            "queued": float(match.group("queued")),
            "dur": float(match.group("dur")),
            "stream": int(match.group("stream")),
            "prompt": _int(match.group("prompt")),
            "completion": _int(match.group("completion")),
            "cache": _int(extra.get("cache")),
            "pms": _int(extra.get("pms")),
            "gms": _int(extra.get("gms")),
            "draft": _int(extra.get("draft")),
            "acc": _int(extra.get("acc")),
            "finish": finish[:32] if finish and finish != "-" else None,
            "gone": _int(extra.get("gone")) or 0,
        }
    match = REJECT_LINE.search(message)
    if match:
        return "rejection", {"user": match.group("user")[:64], "why": match.group("why")[:200]}
    return None


REQUEST_COLUMNS = ("user", "node", "role", "status", "queued", "dur", "stream", "prompt",
                   "completion", "cache", "pms", "gms", "draft", "acc", "finish", "gone")


def store_lines(db, entries):
    """Store (timestamp, message) pairs from the journal."""
    requests, rejections = [], []
    for ts, message in entries:
        parsed = parse_line(message)
        if not parsed:
            continue
        kind, row = parsed
        if kind == "request":
            requests.append((ts,) + tuple(row[c] for c in REQUEST_COLUMNS))
        else:
            rejections.append((ts, row["user"], row["why"]))
    if requests:
        db.executemany("INSERT INTO requests VALUES (%s)" % ",".join("?" * (len(REQUEST_COLUMNS) + 1)), requests)
    if rejections:
        db.executemany("INSERT INTO rejections VALUES (?,?,?)", rejections)
    return len(requests), len(rejections)


def prune(db, path, now=None):
    """Drop history past RETENTION_DAYS, then the oldest days until under the cap."""
    now = now or time.time()
    cutoff = now - RETENTION_DAYS * 86400
    for table in ("samples", "gateway", "requests", "rejections"):
        db.execute("DELETE FROM %s WHERE ts < ?" % table, (cutoff,))
    db.commit()
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    while size > MAX_DB_BYTES and cutoff < now - 86400:
        cutoff += 86400
        for table in ("samples", "gateway", "requests", "rejections"):
            db.execute("DELETE FROM %s WHERE ts < ?" % table, (cutoff,))
        db.commit()
        db.execute("VACUUM")
        size = os.path.getsize(path)

def http_get(host, port, path, key, timeout=4):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request("GET", path, headers={"Authorization": "Bearer " + key} if key else {})
        response = conn.getresponse()
        body = response.read()
        return body if response.status == 200 else None
    except (OSError, http.client.HTTPException):
        return None
    finally:
        conn.close()


def parse_metrics(text):
    """Prometheus text to {name: float}; labelled series keep their braces."""
    metrics = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        name, _, value = line.rpartition(" ")
        try:
            metrics[name.strip()] = float(value)
        except ValueError:
            pass
    return metrics


def parse_slots(raw):
    slots = []
    for slot in raw if isinstance(raw, list) else []:
        if not isinstance(slot, dict):
            continue
        decoded = 0
        nxt = slot.get("next_token")
        if isinstance(nxt, list) and nxt and isinstance(nxt[0], dict):
            decoded = int(nxt[0].get("n_decoded") or 0)
        elif isinstance(nxt, dict):
            decoded = int(nxt.get("n_decoded") or 0)
        prompt = int(slot.get("n_prompt_tokens") or 0)
        slots.append({
            "id": slot.get("id"),
            "busy": bool(slot.get("is_processing")),
            "ctx": int(slot.get("n_ctx") or 0),
            "prompt": prompt,
            "decoded": decoded,
            "used": prompt + decoded,
            "processed": int(slot.get("n_prompt_tokens_processed") or 0),
            "cached": int(slot.get("n_prompt_tokens_cache") or 0),
            "task": slot.get("id_task"),
        })
    return slots


# Cumulative llama.cpp counters, and the sample column each one's increase
# goes into.
COUNTERS = {
    "llamacpp:prompt_tokens_total": "d_prompt",
    "llamacpp:prompt_tokens_cached_total": "d_cached",
    "llamacpp:tokens_predicted_total": "d_gen",
    "llamacpp:prompt_seconds_total": "d_prompt_s",
    "llamacpp:tokens_predicted_seconds_total": "d_gen_s",
    "llamacpp:spec_decode_num_draft_tokens_total": "d_draft",
    "llamacpp:spec_decode_num_accepted_tokens_total": "d_acc",
}


def counter_deltas(before, after):
    """Increase of each counter; a counter that went down means the server
    restarted, so its whole current value is the increase."""
    out = {}
    for name, column in COUNTERS.items():
        now = after.get(name)
        if now is None:
            out[column] = None
            continue
        then = before.get(name) if before else None
        out[column] = now if then is None or now < then else now - then
    return out


def parse_left(text):
    """Slurm's remaining time, [D-]HH:MM:SS or MM:SS, as seconds."""
    match = re.match(r"^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$", text or "")
    if not match:
        return None
    days, hours, minutes, seconds = (int(g) if g else 0 for g in match.groups())
    return ((days * 24 + hours) * 60 + minutes) * 60 + seconds


class Collector:
    def __init__(self, config, db):
        self.config = config
        self.db = db
        self.db_lock = threading.Lock()
        self.lock = threading.Lock()
        self.live = {"time": None, "nodes": [], "gateway": None, "job": None}
        self.props = {}
        self.props_at = 0.0
        self.base = {}       # node -> counters at the last stored sample
        self.base_at = {}
        self.job = None
        self.job_at = 0.0
        self.recent = deque(maxlen=200)

    # -- the servers --

    def poll_node(self, label, host, port, key):
        node = {"label": label, "up": False, "slots": []}
        body = http_get(host, port, "/metrics", key)
        metrics = parse_metrics(body.decode("utf-8", "replace")) if body else None
        if metrics is None:
            return node, None
        node["up"] = True
        slots = http_get(host, port, "/slots", key)
        try:
            node["slots"] = parse_slots(json.loads(slots)) if slots else []
        except ValueError:
            node["slots"] = []
        node.update(
            processing=int(metrics.get("llamacpp:requests_processing") or 0),
            deferred=int(metrics.get("llamacpp:requests_deferred") or 0),
            gen_rate=metrics.get("llamacpp:predicted_tokens_seconds") or 0.0,
            prompt_rate=metrics.get("llamacpp:prompt_tokens_seconds") or 0.0,
            longest=int(metrics.get("llamacpp:n_tokens_max") or 0),
            busy_per_decode=metrics.get("llamacpp:n_busy_slots_per_decode"),
            totals={column: metrics.get(name) for name, column in COUNTERS.items()},
            accept_by_pos=[
                metrics[k] for k in sorted(
                    (k for k in metrics if k.startswith("llamacpp:spec_decode_num_accepted_tokens_per_pos_total")),
                    key=lambda k: int(re.sub(r"\D", "", k.split("{", 1)[-1]) or 0))
            ],
        )
        return node, metrics

    def refresh_props(self, key):
        if time.time() - self.props_at < PROPS_EVERY and self.props:
            return
        self.props_at = time.time()
        for label, host, port in self.config.nodes:
            body = http_get(host, port, "/props", key)
            try:
                props = json.loads(body) if body else None
            except ValueError:
                props = None
            if not isinstance(props, dict):
                continue
            settings = (props.get("default_generation_settings") or {}).get("params") or {}
            self.props[label] = {
                "model": props.get("model_alias"),
                "quant": props.get("model_ftype"),
                "file": os.path.basename(str(props.get("model_path") or "")),
                "build": props.get("build_info"),
                "slots": props.get("total_slots"),
                "ctx": (props.get("default_generation_settings") or {}).get("n_ctx"),
                "temperature": settings.get("temperature"),
                "top_p": settings.get("top_p"),
                "top_k": settings.get("top_k"),
                "min_p": settings.get("min_p"),
            }

    def read_gateway(self):
        try:
            with open(self.config.gateway_state, "r", encoding="utf-8") as handle:
                state = json.load(handle)
        except (OSError, ValueError):
            return None
        if time.time() - float(state.get("time") or 0) > 10:
            return None  # The gateway is not writing it: down, not idle.
        return state

    def tick(self, store):
        key = self.config.upstream_key()
        self.refresh_props(key)
        nodes, rows, now = [], [], time.time()
        for label, host, port in self.config.nodes:
            node, metrics = self.poll_node(label, host, port, key)
            node["props"] = self.props.get(label)
            nodes.append(node)
            if not store:
                continue
            busy = sum(1 for s in node["slots"] if s["busy"])
            row = {"ts": now, "node": label, "up": int(node["up"]), "busy": busy if node["up"] else None,
                   "slots": len(node["slots"]) or None, "deferred": node.get("deferred"),
                   "used": sum(s["used"] for s in node["slots"]) if node["slots"] else None,
                   "secs": None}
            row.update({column: None for column in COUNTERS.values()})
            if metrics is not None:
                if label in self.base:
                    row.update(counter_deltas(self.base[label], metrics))
                    row["secs"] = now - self.base_at[label]
                self.base[label], self.base_at[label] = metrics, now
            rows.append(row)
        gateway = self.read_gateway()
        with self.lock:
            self.live = {"time": now, "nodes": nodes, "gateway": gateway, "job": self.job,
                         "maxInflight": self.config.max_inflight}
        if not store:
            return
        with self.db_lock:
            self.db.executemany(
                "INSERT INTO samples VALUES (:ts,:node,:up,:busy,:slots,:deferred,:used,:secs,"
                ":d_prompt,:d_cached,:d_gen,:d_prompt_s,:d_gen_s,:d_draft,:d_acc)", rows)
            if gateway:
                self.db.execute("INSERT INTO gateway VALUES (?,?,?,?,?)", (
                    now, gateway.get("inflight"), gateway.get("max_inflight"),
                    gateway.get("leads_waiting"), gateway.get("workers_inflight")))
            self.db.commit()

    # -- the gateway's journal --

    def ingest_journal(self):
        with self.db_lock:
            row = self.db.execute("SELECT v FROM kv WHERE k='cursor'").fetchone()
        cursor = row[0] if row else None
        command = ["journalctl", "--user", "-u", self.config.gateway_unit, "-o", "json", "--no-pager"]
        if cursor:
            command += ["--after-cursor", cursor]
        else:
            command += ["--since", time.strftime("%Y-%m-%d %H:%M:%S",
                                                 time.localtime(time.time() - RETENTION_DAYS * 86400))]
        try:
            output = subprocess.run(command, capture_output=True, text=True, timeout=60, check=False).stdout
        except (OSError, subprocess.SubprocessError):
            return
        entries, last = [], None
        for line in output.splitlines():
            try:
                item = json.loads(line)
            except ValueError:
                continue
            message = item.get("MESSAGE")
            if isinstance(message, list):
                message = bytes(b & 0xFF for b in message if isinstance(b, int)).decode("utf-8", "replace")
            last = item.get("__CURSOR") or last
            if not isinstance(message, str):
                continue
            try:
                ts = int(item.get("__REALTIME_TIMESTAMP")) / 1e6
            except (TypeError, ValueError):
                continue
            entries.append((ts, message))
        with self.db_lock:
            requests, rejections = store_lines(self.db, entries)
            if last:
                self.db.execute("INSERT OR REPLACE INTO kv VALUES ('cursor', ?)", (last,))
            self.db.commit()
        if requests or rejections:
            log("journal: %d requests, %d rejections" % (requests, rejections))

    # -- Slurm --

    def refresh_job(self):
        if time.time() - self.job_at < SLURM_EVERY:
            return
        self.job_at = time.time()
        job = None
        try:
            result = subprocess.run(
                ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", self.config.ssh_host,
                 "squeue -h -u %s -n %s -o '%%i|%%T|%%L|%%l|%%S|%%N'" % (self.config.service_user, self.config.job_name)],
                capture_output=True, text=True, timeout=25, check=False, stdin=subprocess.DEVNULL)
            for line in result.stdout.splitlines():
                fields = line.strip().split("|")
                if len(fields) == 6 and fields[0].isdigit():
                    job = {"id": fields[0], "state": fields[1], "left": parse_left(fields[2]),
                           "limit": parse_left(fields[3]), "start": fields[4], "nodes": fields[5],
                           "checked": time.time()}
                    break
            if job is None and result.returncode == 0:
                job = {"state": "NONE", "checked": time.time()}
        except (OSError, subprocess.SubprocessError):
            job = None
        self.job = job

    def run(self, stop):
        last_sample = last_journal = last_prune = 0.0
        while not stop.is_set():
            started = time.time()
            try:
                store = started - last_sample >= SAMPLE_EVERY
                self.tick(store)
                if store:
                    last_sample = started
                if started - last_journal >= JOURNAL_EVERY:
                    last_journal = started
                    self.ingest_journal()
                self.refresh_job()
                if started - last_prune >= PRUNE_EVERY:
                    last_prune = started
                    with self.db_lock:
                        prune(self.db, self.config.db_path)
            except Exception as error:  # A bad sample must not stop collection.
                log("collect failed: %r" % (error,))
            stop.wait(max(0.2, LIVE_EVERY - (time.time() - started)))

RANGES = {
    # name: (span seconds, bucket seconds)
    "1h": (3600, 60),
    "6h": (6 * 3600, 300),
    "24h": (86400, 900),
    "7d": (7 * 86400, 7200),
    "30d": (30 * 86400, 6 * 3600),
}


def _ratio(numerator, denominator):
    return (numerator / denominator) if numerator is not None and denominator else None


def history(db, name, now=None):
    """Bucketed time series for the charts."""
    span, step = RANGES[name]
    now = now or time.time()
    start = (now - span) // step * step
    buckets = [start + i * step for i in range(int((now - start) // step) + 1)]
    nodes = {}
    for row in db.execute(
            "SELECT node, CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(*), SUM(up), AVG(busy), MAX(slots),"
            " MAX(deferred), AVG(used), SUM(secs), SUM(d_prompt), SUM(d_cached), SUM(d_gen),"
            " SUM(d_prompt_s), SUM(d_gen_s), SUM(d_draft), SUM(d_acc)"
            " FROM samples WHERE ts >= ? GROUP BY node, b", (start, step, start)):
        (node, b, count, up, busy, slots, deferred, used, secs,
         prompt, cached, gen, prompt_s, gen_s, draft, acc) = row
        series = nodes.setdefault(node, {})
        series[b] = {
            "up": _ratio(up, count),
            "busy": busy, "slots": slots, "deferred": deferred, "used": used,
            # Throughput over wall time: what the node delivered, all slots.
            "genTps": _ratio(gen, secs), "promptTps": _ratio(prompt, secs),
            # Speed while working: what one request sees.
            "genSpeed": _ratio(gen, gen_s), "promptSpeed": _ratio(prompt, prompt_s),
            "cacheHit": _ratio(cached, (cached or 0) + (prompt or 0)),
            "accept": _ratio(acc, draft),
            "busyFrac": _ratio(((gen_s or 0) + (prompt_s or 0)), secs),
            "gen": gen, "prompt": prompt, "cached": cached,
        }
    gateway = {}
    for b, inflight, waiting, workers, cap in db.execute(
            "SELECT CAST((ts - ?) / ? AS INTEGER) AS b, AVG(inflight), MAX(waiting), AVG(workers), MAX(max)"
            " FROM gateway WHERE ts >= ? GROUP BY b", (start, step, start)):
        gateway[b] = {"inflight": inflight, "waiting": waiting, "workers": workers, "max": cap}
    requests = {}
    for b, count, errors, queued, maxq, dur, prompt, completion, cache in db.execute(
            "SELECT CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(*), SUM(status >= 400), AVG(queued),"
            " MAX(queued), AVG(dur), SUM(prompt), SUM(completion), SUM(cache)"
            " FROM requests WHERE ts >= ? GROUP BY b", (start, step, start)):
        requests[b] = {"count": count, "errors": errors, "queued": queued, "maxQueued": maxq,
                       "dur": dur, "prompt": prompt, "completion": completion, "cache": cache}
    for b, count in db.execute(
            "SELECT CAST((ts - ?) / ? AS INTEGER) AS b, COUNT(*) FROM rejections WHERE ts >= ? GROUP BY b",
            (start, step, start)):
        requests.setdefault(b, {"count": 0})["rejected"] = count
    users = {}
    for user, b, completion, prompt in db.execute(
            "SELECT user, CAST((ts - ?) / ? AS INTEGER) AS b, SUM(completion), SUM(prompt)"
            " FROM requests WHERE ts >= ? GROUP BY user, b", (start, step, start)):
        users.setdefault(user, {})[b] = {"completion": completion, "prompt": prompt}
    index = range(len(buckets))
    return {
        "range": name, "step": step, "times": buckets,
        "nodes": {n: [s.get(i) for i in index] for n, s in sorted(nodes.items())},
        "gateway": [gateway.get(i) for i in index],
        "requests": [requests.get(i) for i in index],
        "users": {u: [s.get(i) for i in index] for u, s in sorted(users.items())},
    }


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(round(fraction * (len(ordered) - 1))))]


def usage(db, name, now=None):
    """Per-user totals, latency percentiles and patterns over a range."""
    span, _step = RANGES[name]
    now = now or time.time()
    start = now - span
    per_user = {}
    rows = db.execute(
        "SELECT user, node, role, status, queued, dur, prompt, completion, cache, pms, gms, draft, acc,"
        " finish, gone, stream FROM requests WHERE ts >= ?", (start,)).fetchall()
    finishes, nodes = {}, {}
    for (user, node, role, status, queued, dur, prompt, completion, cache, pms, gms, draft, acc,
         finish, gone, stream) in rows:
        u = per_user.setdefault(user, {
            "user": user, "requests": 0, "errors": 0, "rejected": 0, "leads": 0, "workers": 0,
            "prompt": 0, "completion": 0, "cache": 0, "gms": 0, "pms": 0, "read": 0,
            "draft": 0, "acc": 0, "gone": 0, "durs": [], "queues": [], "ttfts": [], "nodes": {},
            "metered": 0})
        u["requests"] += 1
        u["errors"] += 1 if status >= 400 else 0
        u["leads"] += 1 if role == "lead" else 0
        u["workers"] += 1 if role == "worker" else 0
        u["gone"] += gone or 0
        u["nodes"][node] = u["nodes"].get(node, 0) + 1
        u["durs"].append(dur)
        u["queues"].append(queued)
        if prompt is not None:
            u["metered"] += 1
            u["prompt"] += prompt
            u["completion"] += completion or 0
            u["cache"] += cache or 0
            u["read"] += max(0, prompt - (cache or 0))
        if gms:
            u["gms"] += gms
        if pms is not None:
            u["pms"] += pms
            if stream:
                u["ttfts"].append(queued + pms / 1000.0)
        u["draft"] += draft or 0
        u["acc"] += acc or 0
        if finish:
            finishes[finish] = finishes.get(finish, 0) + 1
        nodes[node] = nodes.get(node, 0) + 1
    for user, count in db.execute("SELECT user, COUNT(*) FROM rejections WHERE ts >= ? GROUP BY user", (start,)):
        per_user.setdefault(user, {"user": user, "requests": 0, "durs": [], "queues": [], "ttfts": []})["rejected"] = count
    users = []
    for u in per_user.values():
        durs, queues, ttfts = u.pop("durs"), u.pop("queues"), u.pop("ttfts")
        u.update(
            durP50=percentile(durs, 0.5), durP95=percentile(durs, 0.95),
            queueAvg=(sum(queues) / len(queues)) if queues else None, queueMax=max(queues) if queues else None,
            ttftP50=percentile(ttfts, 0.5), ttftP95=percentile(ttfts, 0.95),
            genSpeed=_ratio(u.get("completion"), (u.get("gms") or 0) / 1000.0) if u.get("gms") else None,
            promptSpeed=_ratio(u.get("read"), (u.get("pms") or 0) / 1000.0) if u.get("pms") else None,
            cacheHit=_ratio(u.get("cache"), u.get("prompt")),
            accept=_ratio(u.get("acc"), u.get("draft")),
        )
        users.append(u)
    users.sort(key=lambda u: -(u.get("completion") or 0) - (u.get("requests") or 0))

    # Hour-of-week activity over the whole retention window, in local time.
    heat = [[0] * 24 for _ in range(7)]
    for ts, in db.execute("SELECT ts FROM requests WHERE ts >= ?", (now - RETENTION_DAYS * 86400,)):
        t = time.localtime(ts)
        heat[t.tm_wday][t.tm_hour] += 1
    # Tokens per local day per user, for the last 30 days.
    days = {}
    for ts, user, prompt, completion in db.execute(
            "SELECT ts, user, prompt, completion FROM requests WHERE ts >= ? AND prompt IS NOT NULL",
            (now - 30 * 86400,)):
        day = time.strftime("%Y-%m-%d", time.localtime(ts))
        entry = days.setdefault(day, {}).setdefault(user, [0, 0])
        entry[0] += prompt or 0
        entry[1] += completion or 0
    return {"range": name, "users": users, "finishes": finishes, "nodes": nodes,
            "heat": heat, "days": [{"day": d, "users": days[d]} for d in sorted(days)]}


def recent(db, limit=100):
    rows = db.execute(
        "SELECT ts, " + ", ".join(REQUEST_COLUMNS) + " FROM requests ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    out = [dict(zip(("ts",) + REQUEST_COLUMNS, row)) for row in rows]
    rejected = db.execute("SELECT ts, user, why FROM rejections ORDER BY ts DESC LIMIT 20").fetchall()
    return {"requests": out, "rejections": [{"ts": t, "user": u, "why": w} for t, u, w in rejected]}


def totals(db):
    row = db.execute("SELECT COUNT(*), SUM(prompt), SUM(completion), MIN(ts) FROM requests").fetchone()
    return {"requests": row[0], "prompt": row[1], "completion": row[2], "since": row[3]}

class Dashboard:
    def __init__(self, config, collector):
        self.config = config
        self.collector = collector
        self.web_files = set()
        if os.path.isdir(config.web_dir):
            self.web_files = {f for f in os.listdir(config.web_dir) if WEB_FILE.match(f)}

    def reader(self):
        db = sqlite3.connect("file:%s?mode=ro" % self.config.db_path, uri=True, timeout=10)
        return db

def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "tellico-dashboard"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 -- base name
            pass

        def send_bytes(self, status, body, content_type, extra=None, cache="no-store"):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def send_json(self, status, payload, extra=None):
            self.send_bytes(status, json.dumps(payload, separators=(",", ":")).encode(), "application/json", extra)

        def fail(self, status, message):
            self.send_json(status, {"error": message})

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            parts = urlsplit(self.path)
            path = parts.path
            if path == PREFIX:
                self.send_bytes(308, b"", "text/plain", {"Location": PREFIX + "/"})
                return
            if not path.startswith(PREFIX + "/"):
                self.fail(404, "Not found.")
                return
            rest = path[len(PREFIX) + 1:]
            if rest == "healthz":
                live = app.collector.live
                self.send_json(200, {"ok": True, "sampled": live.get("time")})
                return
            if rest.startswith("api/"):
                self.api_get(rest[4:], parse_qs(parts.query))
                return
            self.static(rest or "index.html")

        def static(self, name):
            if name not in app.web_files:
                if name == "index.html":
                    # No page installed: point at the data instead.
                    self.send_json(200, {"views": {
                        "live": PREFIX + "/api/live",
                        "usage": PREFIX + "/api/usage?range=24h",
                        "history": PREFIX + "/api/history?range=24h",
                        "recent": PREFIX + "/api/recent",
                        "ranges": sorted(RANGES),
                    }})
                    return
                self.fail(404, "Not found.")
                return
            with open(os.path.join(app.config.web_dir, name), "rb") as handle:
                body = handle.read()
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type.endswith("javascript"):
                content_type += "; charset=utf-8"
            self.send_bytes(200, body, content_type, cache="no-cache")

        def api_get(self, route, query):
            name = (query.get("range") or ["24h"])[0]
            if name not in RANGES:
                self.fail(400, "Unknown range.")
                return
            try:
                if route == "live":
                    with app.collector.lock:
                        live = dict(app.collector.live)
                    self.send_json(200, live)
                    return
                db = app.reader()
                try:
                    if route == "history":
                        payload = history(db, name)
                    elif route == "usage":
                        payload = usage(db, name)
                    elif route == "recent":
                        payload = recent(db)
                        payload["totals"] = totals(db)
                    else:
                        self.fail(404, "Not found.")
                        return
                finally:
                    db.close()
                self.send_json(200, payload)
            except sqlite3.Error as error:
                log("query %s failed: %s" % (route, error))
                self.fail(503, "The history database is not ready yet.")

    return Handler


def _fmt_count(n):
    if n is None:
        return "-"
    for unit, size in (("B", 1e9), ("M", 1e6), ("k", 1e3)):
        if abs(n) >= size:
            return "%.1f%s" % (n / size, unit)
    return "%d" % n


def _fmt_pct(x):
    return "-" if x is None else "%d%%" % round(100 * x)


def _fmt_secs(x):
    return "-" if x is None else ("%.1fs" % x if x < 100 else "%dm" % round(x / 60))


def report(db, name, out=sys.stdout):
    """The stored history as plain text, for a terminal over ssh."""
    span, step = RANGES[name]
    hist = history(db, name)
    use = usage(db, name)
    write = out.write
    write("Tellico usage, last %s\n\n" % name)
    write("Nodes\n")
    write("  %-7s %6s %6s %9s %9s %9s %9s %6s %7s\n" % (
        "node", "up", "busy", "gen t/s", "read t/s", "gen spd", "read spd", "cache", "accept"))
    for node, series in hist["nodes"].items():
        rows = [r for r in series if r]
        if not rows:
            continue
        def total(field):
            values = [r.get(field) for r in rows if r.get(field) is not None]
            return sum(values) if values else None
        def mean(field):
            values = [r.get(field) for r in rows if r.get(field) is not None]
            return sum(values) / len(values) if values else None
        gen, prompt, cached = total("gen"), total("prompt"), total("cached")
        write("  %-7s %6s %6s %9s %9s %9s %9s %6s %7s\n" % (
            node, _fmt_pct(mean("up")), "%.2f" % (mean("busy") or 0),
            "%.1f" % ((gen or 0) / span), "%.0f" % ((prompt or 0) / span),
            "%.1f" % (mean("genSpeed") or 0), "%.0f" % (mean("promptSpeed") or 0),
            _fmt_pct(_ratio(cached, (cached or 0) + (prompt or 0))), _fmt_pct(mean("accept"))))
    write("\nUsers\n")
    write("  %-14s %6s %5s %5s %8s %8s %8s %6s %7s %7s %7s %7s\n" % (
        "user", "reqs", "err", "rej", "in", "cached", "out", "cache", "p50", "p95", "ttft", "queue"))
    for u in use["users"]:
        write("  %-14s %6d %5d %5d %8s %8s %8s %6s %7s %7s %7s %7s\n" % (
            u["user"][:14], u.get("requests", 0), u.get("errors", 0), u.get("rejected", 0),
            _fmt_count(u.get("prompt")), _fmt_count(u.get("cache")), _fmt_count(u.get("completion")),
            _fmt_pct(u.get("cacheHit")), _fmt_secs(u.get("durP50")), _fmt_secs(u.get("durP95")),
            _fmt_secs(u.get("ttftP50")), _fmt_secs(u.get("queueAvg"))))
    if not use["users"]:
        write("  (no requests)\n")
    if use["finishes"]:
        write("\nHow replies ended: %s\n" % ", ".join(
            "%s %d" % item for item in sorted(use["finishes"].items(), key=lambda i: -i[1])))
    write("\nBusiest hours (requests, last %d days, local time)\n" % RETENTION_DAYS)
    write("       0     6     12    18    (hour)\n")
    shades = " .:-=+*#%@"
    peak = max(max(row) for row in use["heat"]) or 1
    for day, row in zip(("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"), use["heat"]):
        cells = "".join(shades[min(9, int(round(9 * v / peak)))] for v in row)
        write("  %s  %s\n" % (day, cells))
    write("\n")


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "report":
        name = sys.argv[2] if len(sys.argv) > 2 else "24h"
        if name not in RANGES:
            sys.stderr.write("tellico-dashboard report: range is one of %s\n" % ", ".join(RANGES))
            sys.exit(2)
        config = Config()
        try:
            db = sqlite3.connect("file:%s?mode=ro" % config.db_path, uri=True, timeout=10)
            report(db, name)
        except sqlite3.Error as error:
            sys.stderr.write("tellico-dashboard report: cannot read %s: %s\n" % (config.db_path, error))
            sys.exit(1)
        return
    config = Config()
    os.makedirs(config.state_dir, mode=0o700, exist_ok=True)
    db = connect(config.db_path)
    os.chmod(config.db_path, 0o600)
    collector = Collector(config, db)
    app = Dashboard(config, collector)
    if config.bind not in ("127.0.0.1", "::1", "localhost"):
        log("refusing to listen on %s: the dashboard has no access control of its own" % config.bind)
        sys.exit(2)
    if not app.web_files:
        log("warning: no web files in %s" % config.web_dir)
    stop = threading.Event()
    if config.collect:
        threading.Thread(target=collector.run, args=(stop,), daemon=True).start()
    server = ThreadingHTTPServer((config.bind, config.port), make_handler(app))
    server.daemon_threads = True
    log("listening on http://%s:%d%s/ nodes=%s db=%s" % (
        config.bind, config.port, PREFIX, ",".join(n[0] for n in config.nodes), config.db_path))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
