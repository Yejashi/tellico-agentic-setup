#!/usr/bin/env python3
"""OpenAI-compatible front door for the two Tellico Qwen servers.

Runs on a host that already has tellico-qwen-tunnel up, so both cluster
endpoints answer on 127.0.0.1. It holds per-user API keys, caps how much of
the cluster's small concurrency budget it is allowed to consume, spreads
requests across the two nodes, and says plainly when the Slurm allocation
has gone away.

Standard library only, on purpose: a gateway host should need nothing but
python3. See gateway/README.md for the operator view.
"""

import hashlib
import hmac
import http.client
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONFIG_HOME = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")


def _env(name, default):
    value = os.environ.get(name, "").strip()
    return value if value else default


def _env_int(name, default):
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


BIND = _env("TELLICO_GATEWAY_BIND", "127.0.0.1")
PORT = _env_int("TELLICO_GATEWAY_PORT", 4000)
KEYS_FILE = os.path.expanduser(
    _env("TELLICO_GATEWAY_KEYS", os.path.join(CONFIG_HOME, "tellico-gateway/keys"))
)
UPSTREAM_KEY_FILE = os.path.expanduser(
    _env(
        "TELLICO_GATEWAY_UPSTREAM_KEY",
        os.path.join(CONFIG_HOME, "tellico-qwen/api-key"),
    )
)

# How many of the cluster's four slots (2 per node) the gateway may hold at
# once. The default leaves one free so a direct opencode-tellico lead is never
# blocked behind API users; within the three, leads go first (see Pool).
MAX_INFLIGHT = _env_int("TELLICO_GATEWAY_MAX_INFLIGHT", 3)
DEFAULT_MAX_PARALLEL = _env_int("TELLICO_GATEWAY_DEFAULT_MAX_PARALLEL", 1)
QUEUE_TIMEOUT = _env_int("TELLICO_GATEWAY_QUEUE_TIMEOUT", 120)
REQUEST_TIMEOUT = _env_int("TELLICO_GATEWAY_REQUEST_TIMEOUT", 3600)
MAX_BODY = _env_int("TELLICO_GATEWAY_MAX_BODY", 32 * 1024 * 1024)
HEALTH_INTERVAL = _env_int("TELLICO_GATEWAY_HEALTH_INTERVAL", 10)

MODEL = _env("TELLICO_GATEWAY_MODEL", "qwen3.8-27b-gsq-iq3s")
# Earlier model ids that still route to MODEL, so a client configured before a
# model swap keeps working instead of getting a 404. Space-separated.
MODEL_ALIASES = _env("TELLICO_GATEWAY_MODEL_ALIASES", "qwen3.6-35b-a3b qwen3.8-27b").split()

# Live state for tellico-gateway monitor. A file rather than an HTTP endpoint
# because the port is published to the internet and this carries user names.
RUNTIME_DIR = os.path.expanduser(
    _env(
        "TELLICO_GATEWAY_RUNTIME",
        os.path.join(
            os.environ.get("XDG_RUNTIME_DIR") or os.path.expanduser("~/.cache"),
            "tellico-gateway",
        ),
    )
)
STATE_PATH = os.path.join(RUNTIME_DIR, "state.json")
CONTEXT = _env_int("TELLICO_GATEWAY_CONTEXT", 131072)

# /v1/responses is what Codex speaks: its wire_api accepts only "responses",
# and llama.cpp implements that endpoint.
PROXY_PATHS = (
    "/v1/chat/completions",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/responses",
)
HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "content-length",
    "date",
    "server",
}


def log(message):
    sys.stdout.write(
        "%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S%z", time.localtime()), message)
    )
    sys.stdout.flush()


def parse_nodes(spec):
    """"node0=127.0.0.1:18080 node1=..." -> [(label, host, port), ...]"""
    nodes = []
    for item in spec.split():
        label, _, address = item.partition("=")
        host, _, port = address.rpartition(":")
        if not (label and host and port.isdigit()):
            raise SystemExit("tellico-gateway: bad TELLICO_GATEWAY_NODES item: %r" % item)
        nodes.append((label, host, int(port)))
    if not nodes:
        raise SystemExit("tellico-gateway: TELLICO_GATEWAY_NODES is empty")
    return nodes


NODES = parse_nodes(
    _env(
        "TELLICO_GATEWAY_NODES",
        "node0=127.0.0.1:18080 node1=127.0.0.1:18081",
    )
)


class Keys:
    """Per-user API keys, stored as hashes and reloaded when the file changes.

    Each line is "<sha256-hex> <user> [max_parallel]". The gateway never sees
    or stores a plaintext key: tellico-gateway add-user prints it once.
    """

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._stamp = None
        self._entries = {}

    def _reload_locked(self):
        try:
            stat = os.stat(self.path)
        except OSError:
            self._entries = {}
            self._stamp = None
            return
        stamp = (stat.st_mtime_ns, stat.st_size)
        if stamp == self._stamp:
            return
        entries = {}
        with open(self.path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                fields = line.split()
                digest, user = fields[0].lower(), fields[1]
                limit = DEFAULT_MAX_PARALLEL
                if len(fields) > 2:
                    try:
                        limit = max(1, int(fields[2]))
                    except ValueError:
                        pass
                entries[digest] = (user, limit)
        self._entries = entries
        self._stamp = stamp

    def lookup(self, presented):
        """Return (user, max_parallel) or None, comparing in constant time."""
        digest = hashlib.sha256(presented.encode("utf-8")).hexdigest()
        with self._lock:
            self._reload_locked()
            entries = self._entries
        for known, value in entries.items():
            if hmac.compare_digest(known, digest):
                return value
        return None


class Pool:
    """Admission control and node selection under one lock.

    Both the global cap and the per-user cap are waited on together, so a
    request never holds one budget while queuing for the other.
    """

    def __init__(self, nodes, max_inflight):
        self.max_inflight = max_inflight
        self._cond = threading.Condition()
        self._inflight = 0
        # Lead-first admission. The cluster has few slots, and a lead request
        # is a person waiting at a prompt while a worker's is background work,
        # so a worker never takes a slot while a lead is queued, and workers
        # together never hold every slot. Roles come from the
        # X-Tellico-Role header; anything not marked "worker" counts as a lead.
        self._leads_waiting = 0
        self._workers_inflight = 0
        self._per_user = {}
        self._per_node = {label: 0 for label, _, _ in nodes}
        self._healthy = {label: False for label, _, _ in nodes}
        self._upstream_model = {label: None for label, _, _ in nodes}

    def set_health(self, label, healthy, upstream_model=None):
        with self._cond:
            was = self._healthy[label]
            self._healthy[label] = healthy
            if upstream_model:
                self._upstream_model[label] = upstream_model
            if healthy and not was:
                self._cond.notify_all()
        if was != healthy:
            log("node %s is %s" % (label, "up" if healthy else "down"))

    def healthy_labels(self):
        with self._cond:
            return [label for label, up in self._healthy.items() if up]

    def upstream_model(self, label):
        with self._cond:
            return self._upstream_model.get(label)

    def snapshot(self):
        with self._cond:
            return {
                "inflight": self._inflight,
                "max_inflight": self.max_inflight,
                "workers_inflight": self._workers_inflight,
                "leads_waiting": self._leads_waiting,
                "users": dict(self._per_user),
                "nodes": {
                    label: {
                        "status": "up" if self._healthy[label] else "down",
                        "inflight": self._per_node[label],
                    }
                    for label in self._healthy
                },
            }

    def _worker_may_start(self):
        if self._leads_waiting:
            return False
        # Workers together hold at most all but one slot, so a lead arriving
        # later never finds every slot taken by background work. With a
        # single slot there is nothing to reserve.
        if self.max_inflight >= 2 and self._workers_inflight >= self.max_inflight - 1:
            return False
        return True

    def acquire(self, user, user_limit, want, timeout, role="lead"):
        """Wait for a slot and return (label, queued_seconds), or (None, reason).

        want is a list of acceptable node labels; the least busy healthy one
        wins. Returns a reason string of "timeout" or "unavailable" instead of
        a label when it cannot be satisfied. role is "lead" or "worker"; see
        __init__ for how they are ordered.
        """
        worker = role == "worker"
        deadline = time.monotonic() + timeout
        started = time.monotonic()
        with self._cond:
            if not worker:
                self._leads_waiting += 1
            try:
                while True:
                    mine = self._per_user.get(user, 0)
                    options = [l for l in want if self._healthy[l]]
                    if (options and self._inflight < self.max_inflight and mine < user_limit
                            and (not worker or self._worker_may_start())):
                        label = min(options, key=lambda l: self._per_node[l])
                        self._inflight += 1
                        self._per_user[user] = mine + 1
                        self._per_node[label] += 1
                        if worker:
                            self._workers_inflight += 1
                        return label, time.monotonic() - started
                    if not options:
                        # Nothing to queue behind: the allocation is gone rather
                        # than busy, so fail now instead of waiting it out.
                        return None, "unavailable"
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return None, "timeout"
                    self._cond.wait(min(remaining, 1.0))
            finally:
                if not worker:
                    self._leads_waiting -= 1
                    # A lead leaving the queue may unblock a waiting worker.
                    self._cond.notify_all()

    def release(self, user, label, role="lead"):
        with self._cond:
            self._inflight = max(0, self._inflight - 1)
            if role == "worker":
                self._workers_inflight = max(0, self._workers_inflight - 1)
            self._per_node[label] = max(0, self._per_node[label] - 1)
            left = self._per_user.get(user, 1) - 1
            if left > 0:
                self._per_user[user] = left
            else:
                self._per_user.pop(user, None)
            self._cond.notify_all()


def read_upstream_key():
    with open(UPSTREAM_KEY_FILE, "r", encoding="utf-8") as handle:
        return handle.read().strip()


def write_state(pool):
    """Publish a snapshot for the monitor. Best effort: never break a request."""
    try:
        os.makedirs(RUNTIME_DIR, mode=0o700, exist_ok=True)
        payload = pool.snapshot()
        payload["time"] = time.time()
        payload["model"] = MODEL
        temporary = STATE_PATH + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
        os.chmod(temporary, 0o600)
        os.replace(temporary, STATE_PATH)
    except OSError:
        pass


def state_loop(pool, stop):
    while not stop.is_set():
        write_state(pool)
        stop.wait(1.0)


def health_loop(pool, nodes, stop):
    """Poll each node's /v1/models, which checks reachability and the key."""
    while not stop.is_set():
        try:
            key = read_upstream_key()
        except OSError as error:
            log("cannot read upstream key: %s" % error)
            key = None
        for label, host, port in nodes:
            healthy, model_id = False, None
            if key:
                conn = None
                try:
                    conn = http.client.HTTPConnection(host, port, timeout=5)
                    conn.request(
                        "GET", "/v1/models", headers={"Authorization": "Bearer " + key}
                    )
                    response = conn.getresponse()
                    payload = response.read()
                    if response.status == 200:
                        healthy = True
                        try:
                            data = json.loads(payload).get("data") or []
                            if data:
                                model_id = data[0].get("id")
                        except (ValueError, AttributeError):
                            pass
                except (OSError, http.client.HTTPException):
                    healthy = False
                finally:
                    if conn is not None:
                        conn.close()
            pool.set_health(label, healthy, model_id)
        stop.wait(HEALTH_INTERVAL)


KEYS = Keys(KEYS_FILE)
POOL = Pool(NODES, MAX_INFLIGHT)
NODE_BY_LABEL = {label: (host, port) for label, host, port in NODES}
ALL_LABELS = [label for label, _, _ in NODES]
# Pooled name routes to either node; the suffixed names pin one, which is what
# a caller wants when it is driving both nodes itself.
MODEL_ROUTES = {}
for _name in [MODEL] + [a for a in MODEL_ALIASES if a != MODEL]:
    MODEL_ROUTES[_name] = ALL_LABELS
    for _label in ALL_LABELS:
        MODEL_ROUTES["%s-%s" % (_name, _label)] = [_label]


def _item_text(item):
    """Plain text of one Responses input item, whatever shape it uses."""
    content = item.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for piece in content:
            if isinstance(piece, dict) and piece.get("text"):
                parts.append(piece["text"])
            elif isinstance(piece, str):
                parts.append(piece)
        return "\n".join(parts)
    return ""


def fold_system_items(payload):
    """Merge developer and system input items into `instructions`.

    llama.cpp turns `instructions` and any developer item into separate system
    messages, and the Qwen chat template raises "System message must be at the
    beginning" on the second one. Codex always sends both, so every Codex
    request would fail. Folding them into one leading system message is the
    smallest change that keeps the content and satisfies the template.
    """
    items = payload.get("input")
    if not isinstance(items, list):
        return payload

    folded, kept = [], []
    for item in items:
        if (
            isinstance(item, dict)
            and item.get("role") in ("developer", "system")
            and item.get("type") in (None, "message")
        ):
            text = _item_text(item)
            if text:
                folded.append(text)
        else:
            kept.append(item)

    if not folded:
        return payload

    merged = dict(payload)
    existing = (payload.get("instructions") or "").rstrip()
    joined = "\n\n".join(folded)
    merged["instructions"] = (existing + "\n\n" + joined) if existing else joined
    merged["input"] = kept
    return merged


def split_node_prefix(path):
    """"/v1/node0/chat/completions" -> (["node0"], "/v1/chat/completions").

    Lets a caller pin a node by base URL instead of by model name, which is
    what an OpenAI-compatible client with one base URL per provider needs.
    Returns (None, path) when there is no node prefix.
    """
    if path.startswith("/v1/"):
        head, _, rest = path[4:].partition("/")
        if head in NODE_BY_LABEL and rest:
            return [head], "/v1/" + rest
    return None, path


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "tellico-gateway"
    sys_version = ""

    def log_message(self, fmt, *args):
        """Silence the default per-request stderr line; we log our own."""

    def send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for name, value in (extra_headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, message, kind, extra_headers=None):
        self.send_json(
            status,
            {"error": {"message": message, "type": kind, "code": status}},
            extra_headers,
        )

    def authenticate(self):
        header = self.headers.get("Authorization", "")
        presented = ""
        if header.lower().startswith("bearer "):
            presented = header[7:].strip()
        if not presented:
            presented = (self.headers.get("x-api-key") or "").strip()
        if not presented:
            return None
        return KEYS.lookup(presented)

    def models_payload(self):
        snapshot = POOL.snapshot()
        data = []
        for name, labels in MODEL_ROUTES.items():
            up = any(snapshot["nodes"][l]["status"] == "up" for l in labels)
            data.append(
                {
                    "id": name,
                    "object": "model",
                    "owned_by": "tellico",
                    "context_length": CONTEXT,
                    "status": "up" if up else "down",
                }
            )
        data.sort(key=lambda entry: entry["id"])
        # Codex's model lister insists on a "models" array alongside "data",
        # and llama.cpp's own /v1/models carries both; mirror that so it does
        # not log a decode error on every session.
        models = [
            {
                "name": entry["id"],
                "model": entry["id"],
                # Codex's decoder requires slug; llama.cpp omits it, which is
                # why its own /v1/models fails to decode there too.
                "slug": entry["id"],
                "type": "model",
                "description": "",
                "tags": [],
                "capabilities": ["completion"],
            }
            for entry in data
        ]
        return {"object": "list", "data": data, "models": models}

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        _, path = split_node_prefix(path)
        if path == "/health":
            snapshot = POOL.snapshot()
            healthy = any(n["status"] == "up" for n in snapshot["nodes"].values())
            self.send_json(
                200 if healthy else 503,
                {
                    "status": "ok" if healthy else "no_allocation",
                    "inflight": snapshot["inflight"],
                    "max_inflight": snapshot["max_inflight"],
                    "nodes": {k: v["status"] for k, v in snapshot["nodes"].items()},
                },
            )
            return
        if path == "/v1/models":
            if not self.authenticate():
                self.send_error_json(401, "Invalid API key.", "invalid_request_error")
                return
            self.send_json(200, self.models_payload())
            return
        self.send_error_json(404, "Unknown path: %s" % path, "invalid_request_error")

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        prefix_labels, path = split_node_prefix(path)
        if path not in PROXY_PATHS:
            self.send_error_json(
                404, "Unknown path: %s" % path, "invalid_request_error"
            )
            return

        if "chunked" in (self.headers.get("Transfer-Encoding") or "").lower():
            self.close_connection = True
            self.send_error_json(
                411,
                "A Content-Length is required; chunked request bodies are not "
                "accepted.",
                "invalid_request_error",
            )
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0:
            self.close_connection = True
            self.send_error_json(400, "Bad Content-Length.", "invalid_request_error")
            return
        if length > MAX_BODY:
            self.close_connection = True
            self.send_error_json(413, "Request body too large.", "invalid_request_error")
            return

        body = self.rfile.read(length) if length else b""

        identity = self.authenticate()
        if not identity:
            self.send_error_json(401, "Invalid API key.", "invalid_request_error")
            return
        user, user_limit = identity
        role = "worker" if (self.headers.get("X-Tellico-Role") or "").strip().lower() == "worker" else "lead"

        try:
            payload = json.loads(body or b"{}")
            if not isinstance(payload, dict):
                raise ValueError("body must be a JSON object")
        except ValueError as error:
            self.send_error_json(
                400, "Invalid JSON body: %s" % error, "invalid_request_error"
            )
            return

        requested = payload.get("model") or MODEL
        labels = MODEL_ROUTES.get(requested)
        if labels is None:
            self.send_error_json(
                404,
                "Unknown model %r. Available: %s."
                % (requested, ", ".join(sorted(MODEL_ROUTES))),
                "invalid_request_error",
            )
            return

        if prefix_labels is not None:
            # The URL pinned a node and the model name may pin one too; honour
            # both, and say so rather than silently picking one.
            labels = [label for label in labels if label in prefix_labels]
            if not labels:
                self.send_error_json(
                    400,
                    "Model %r cannot run on %s, which this URL pins."
                    % (requested, ", ".join(prefix_labels)),
                    "invalid_request_error",
                )
                return

        stream = bool(payload.get("stream"))
        try:
            upstream_key = read_upstream_key()
        except OSError as error:
            log("user=%s upstream key unreadable: %s" % (user, error))
            self.send_error_json(
                503, "Gateway cannot read its cluster credential.", "api_error"
            )
            return

        remaining = list(labels)
        queued = 0.0
        while remaining:
            label, outcome = POOL.acquire(user, user_limit, remaining, QUEUE_TIMEOUT, role)
            if label is None:
                self.report_unavailable(user, requested, outcome, queued)
                return
            queued += outcome
            host, port = NODE_BY_LABEL[label]
            # Send upstream whatever name that server advertises; the pinned
            # and pooled names are ours, not llama.cpp's.
            upstream_model = POOL.upstream_model(label)
            sent = fold_system_items(payload) if path == "/v1/responses" else dict(payload)
            if upstream_model:
                sent["model"] = upstream_model
            wire = json.dumps(sent).encode("utf-8")
            started = time.monotonic()
            try:
                status, usage = self.forward(
                    path, host, port, wire, stream, upstream_key
                )
            except (OSError, http.client.HTTPException) as error:
                POOL.release(user, label, role)
                POOL.set_health(label, False)
                remaining = [l for l in remaining if l != label]
                if remaining:
                    log(
                        "user=%s model=%s node=%s unreachable (%s), retrying"
                        % (user, requested, label, error.__class__.__name__)
                    )
                    continue
                log("user=%s model=%s node=%s failed: %s" % (user, requested, label, error))
                self.send_error_json(
                    502,
                    "The model server on %s did not answer: %s. The Slurm "
                    "allocation may have ended." % (label, error),
                    "api_error",
                )
                return
            else:
                POOL.release(user, label, role)
                log(
                    "user=%s model=%s node=%s status=%s queued=%.1fs dur=%.1fs "
                    "stream=%d in=%s out=%s"
                    % (
                        user,
                        requested,
                        label,
                        status,
                        queued,
                        time.monotonic() - started,
                        1 if stream else 0,
                        usage.get("prompt_tokens", "-"),
                        usage.get("completion_tokens", "-"),
                    )
                )
                return

    def report_unavailable(self, user, requested, outcome, queued):
        if outcome == "unavailable":
            log("user=%s model=%s rejected: no healthy node" % (user, requested))
            self.send_error_json(
                503,
                "No Tellico model server is reachable. The Slurm allocation "
                "has probably ended; ask the service owner to submit another.",
                "api_error",
                {"Retry-After": "60"},
            )
        else:
            log(
                "user=%s model=%s rejected: queued %ds without a slot"
                % (user, requested, QUEUE_TIMEOUT)
            )
            self.send_error_json(
                429,
                "The cluster is busy: no slot became free within %ds. Tellico "
                "serves only a few concurrent requests." % QUEUE_TIMEOUT,
                "rate_limit_error",
                {"Retry-After": "30"},
            )

    def forward(self, path, host, port, wire, stream, upstream_key):
        """Proxy one request. Raises on a connection-level failure."""
        conn = http.client.HTTPConnection(host, port, timeout=REQUEST_TIMEOUT)
        try:
            conn.request(
                "POST",
                path,
                body=wire,
                headers={
                    "Content-Type": "application/json",
                    "Content-Length": str(len(wire)),
                    "Authorization": "Bearer " + upstream_key,
                    "Accept": self.headers.get("Accept") or "*/*",
                },
            )
            response = conn.getresponse()
            passthrough = [
                (name, value)
                for name, value in response.getheaders()
                if name.lower() not in HOP_BY_HOP
            ]

            if not stream:
                payload = response.read()
                self.send_response(response.status)
                for name, value in passthrough:
                    self.send_header(name, value)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                usage = {}
                try:
                    usage = (json.loads(payload) or {}).get("usage") or {}
                except (ValueError, AttributeError):
                    pass
                return response.status, usage

            # Streaming: re-frame as chunked, since the body length is unknown
            # and the client must see each token as it arrives.
            self.send_response(response.status)
            for name, value in passthrough:
                self.send_header(name, value)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")
            self.end_headers()
            try:
                while True:
                    chunk = response.read(8192)
                    if not chunk:
                        break
                    self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                    self.wfile.flush()
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                # Client hung up mid-generation; stop pulling from upstream.
                self.close_connection = True
            return response.status, {}
        finally:
            conn.close()


def main():
    try:
        read_upstream_key()
    except OSError as error:
        raise SystemExit(
            "tellico-gateway: cannot read the cluster API key at %s (%s).\n"
            "Install the client side first, then run: tellico-qwen-tunnel refresh-key"
            % (UPSTREAM_KEY_FILE, error)
        )
    if not os.path.exists(KEYS_FILE):
        log("warning: no key file at %s; every request will get 401" % KEYS_FILE)
        log("warning: create one with: tellico-gateway add-user <name>")

    stop = threading.Event()
    poller = threading.Thread(
        target=health_loop, args=(POOL, NODES, stop), name="health", daemon=True
    )
    poller.start()

    publisher = threading.Thread(
        target=state_loop, args=(POOL, stop), name="state", daemon=True
    )
    publisher.start()

    ThreadingHTTPServer.allow_reuse_address = True
    ThreadingHTTPServer.daemon_threads = True
    try:
        server = ThreadingHTTPServer((BIND, PORT), Handler)
    except OSError as error:
        raise SystemExit("tellico-gateway: cannot bind %s:%d (%s)" % (BIND, PORT, error))
    server.timeout = None
    socket.setdefaulttimeout(None)

    log(
        "listening on %s:%d  model=%s  nodes=%s  max_inflight=%d"
        % (BIND, PORT, MODEL, ",".join(ALL_LABELS), MAX_INFLIGHT)
    )
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        log("stopped")


if __name__ == "__main__":
    main()
