#!/usr/bin/env python3
"""Tellico relay: follow and steer your own OpenCode sessions from a phone.

Every OpenCode process that opted in runs plugins/remote-control, which
publishes that process's sessions here and long-polls for commands. A phone
signs in with the same gateway API key and sees exactly that user's sessions,
streaming, across every machine and window they have open, and can send a
prompt to one or stop it.

Both sides authenticate with gateway keys, read from the gateway's own keys
file: a user here is a gateway user, and revoking a key with tellico-gateway
revokes it here too, within a second.

Nothing here can reach a user's machine. Their plugin makes every request; the
relay only answers. And the relay can ask a plugin for exactly two things, a
prompt or an interrupt, for a session that plugin itself published.

State is held in memory and rebuilt from the plugins after a restart: each one
notices the new epoch and resends its sessions whole. Only sign-in tokens are
written to disk, so a restart does not sign phones out.

Standard library only, like the gateway.
"""

import hashlib
import hmac
import json
import mimetypes
import os
import queue
import re
import secrets
import sys
import threading
import time
from collections import OrderedDict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PREFIX = "/tellico"
COOKIE = "tellico_relay"

# Host liveness: a plugin long-polls every 25s, so a host this quiet is gone.
HOST_TIMEOUT = 45.0
# A command no plugin picked up in this long reports back as failed.
COMMAND_TIMEOUT = 60.0
# How long an offline host's sessions stay readable.
OFFLINE_RETENTION = 3 * 24 * 3600.0
TOKEN_LIFETIME = 30 * 24 * 3600

MAX_SESSIONS_PER_USER = 300
MAX_HOSTS_PER_USER = 32
MAX_MESSAGES = 400
MAX_PART_TEXT = 256 * 1024
MAX_PUBLISH_BODY = 8 * 1024 * 1024
MAX_SMALL_BODY = 256 * 1024
MAX_PROMPT = 64000
SUBSCRIBER_QUEUE = 5000

LOGIN_WINDOW = 600.0
LOGIN_FAILURES = 10

SESSION_ID = re.compile(r"^ses_[A-Za-z0-9_-]{1,80}$")
MESSAGE_ID = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
PART_KEY = re.compile(r"^(text|reasoning):\d{1,4}$|^tool:[A-Za-z0-9_.:-]{1,128}$")
HOST_ID = re.compile(r"^[A-Za-z0-9-]{8,64}$")
WEB_FILE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

SESSION_FIELDS = {
    "parentID": (str, type(None)), "title": str, "directory": str, "agent": str,
    "model": str, "status": str, "detail": str, "created": (int, float),
    "updated": (int, float), "tokens": dict, "cost": (int, float),
}
MESSAGE_FIELDS = {
    "role": str, "time": (int, float), "text": str, "agent": str, "model": str,
    "finish": str, "error": str,
}
PART_FIELDS = {
    "kind": str, "text": str, "done": bool, "tool": str, "status": str,
    "summary": str, "input": str, "output": str, "error": str,
}
ROLES = {"user", "assistant", "note"}
KINDS = {"text", "reasoning", "tool"}
STATUSES = {"idle", "running", "error", "interrupted"}
HOST_KINDS = {"tui", "vscode", "server"}

SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
        "form-action 'self'"
    ),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
}


def log(message):
    sys.stderr.write("tellico-relay: %s\n" % message)
    sys.stderr.flush()


def _env(name, default):
    value = os.environ.get(name, "")
    return value if value else default


def now():
    return time.time()


def clean(fields, spec):
    """Only the fields this relay knows, of the types it expects."""
    out = {}
    if not isinstance(fields, dict):
        return out
    for key, kinds in spec.items():
        if key not in fields:
            continue
        value = fields[key]
        kinds = kinds if isinstance(kinds, tuple) else (kinds,)
        # bool is an int to isinstance; a flag is never a number here.
        if isinstance(value, bool) and bool not in kinds:
            continue
        if isinstance(value, kinds):
            out[key] = value[:MAX_PART_TEXT] if isinstance(value, str) else value
    return out


class Keys:
    """Gateway user keys, as hashes, reloaded when the file changes.

    The same file and format the gateway reads: "<sha256-hex> <user> [n]".
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
                fields = line.strip().split()
                if len(fields) < 2 or fields[0].startswith("#"):
                    continue
                entries[fields[0].lower()] = fields[1]
        self._entries = entries
        self._stamp = stamp

    @staticmethod
    def digest(presented):
        return hashlib.sha256(presented.encode("utf-8")).hexdigest()

    def user_for_digest(self, digest):
        with self._lock:
            self._reload_locked()
            entries = self._entries
        for known, user in entries.items():
            if hmac.compare_digest(known, digest):
                return user
        return None

    def lookup(self, presented):
        if not presented or len(presented) > 512:
            return None, None
        digest = self.digest(presented)
        return self.user_for_digest(digest), digest


class Tokens:
    """Phone sign-ins. Only hashes are kept, in a 0600 file, so a restart does
    not sign anyone out and a copy of the file signs nobody in."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._entries = {}
        self._load()

    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                for line in handle:
                    fields = line.split()
                    if len(fields) == 4:
                        self._entries[fields[0]] = (fields[1], fields[2], float(fields[3]))
        except OSError:
            pass

    def _save_locked(self):
        if not self.path:
            return
        tmp = "%s.tmp.%d" % (self.path, os.getpid())
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            for digest, (user, key_digest, expires) in self._entries.items():
                handle.write("%s %s %s %d\n" % (digest, user, key_digest, int(expires)))
        os.replace(tmp, self.path)

    def issue(self, user, key_digest):
        token = secrets.token_urlsafe(32)
        with self._lock:
            cutoff = now()
            self._entries = {d: e for d, e in self._entries.items() if e[2] > cutoff}
            self._entries[hashlib.sha256(token.encode()).hexdigest()] = (user, key_digest, now() + TOKEN_LIFETIME)
            self._save_locked()
        return token

    def resolve(self, token):
        if not token or len(token) > 128:
            return None
        digest = hashlib.sha256(token.encode()).hexdigest()
        with self._lock:
            entry = self._entries.get(digest)
        if not entry or entry[2] < now():
            return None
        return entry

    def revoke(self, token):
        digest = hashlib.sha256((token or "").encode()).hexdigest()
        with self._lock:
            if self._entries.pop(digest, None):
                self._save_locked()


class Session:
    def __init__(self, sid, host_id):
        self.id = sid
        self.host_id = host_id
        self.meta = {"id": sid, "status": "idle", "updated": now() * 1000}
        self.messages = OrderedDict()

    def summary(self, hosts):
        meta = dict(self.meta)
        meta["hostId"] = self.host_id
        host = hosts.get(self.host_id)
        meta["online"] = bool(host and host["online"])
        meta["messageCount"] = len(self.messages)
        meta["preview"] = self.preview()
        return meta

    def preview(self):
        for message in reversed(self.messages.values()):
            if message.get("role") == "assistant":
                for part in reversed(list(message["parts"].values())):
                    if part.get("kind") == "text" and part.get("text"):
                        return part["text"][-160:]
            elif message.get("role") == "user" and message.get("text"):
                return message["text"][:160]
        return ""

    def message(self, mid, role="assistant"):
        message = self.messages.get(mid)
        if message is None:
            message = {"id": mid, "role": role, "parts": OrderedDict()}
            self.messages[mid] = message
            while len(self.messages) > MAX_MESSAGES:
                self.messages.popitem(last=False)
        return message

    def export(self):
        out = []
        for message in self.messages.values():
            item = {k: v for k, v in message.items() if k != "parts"}
            item["parts"] = list(message["parts"].values())
            out.append(item)
        return out


class User:
    def __init__(self, name):
        self.name = name
        self.hosts = {}
        self.sessions = OrderedDict()
        self.commands = {}
        self.pending = {}
        self.subscribers = set()


class Store:
    """Everything every user's plugins have published, and who is listening."""

    def __init__(self):
        self.lock = threading.RLock()
        self.changed = threading.Condition(self.lock)
        self.users = {}
        self.epoch = secrets.token_hex(8)

    def user(self, name):
        user = self.users.get(name)
        if user is None:
            user = self.users[name] = User(name)
        return user

    # --- fan-out ---------------------------------------------------------

    def subscribe(self, name):
        q = queue.Queue(maxsize=SUBSCRIBER_QUEUE)
        with self.lock:
            self.user(name).subscribers.add(q)
        return q

    def unsubscribe(self, name, q):
        with self.lock:
            self.user(name).subscribers.discard(q)

    def _emit(self, user, kind, payload):
        dead = []
        for q in user.subscribers:
            try:
                q.put_nowait((kind, payload))
            except queue.Full:
                dead.append(q)
        for q in dead:
            # Too far behind to catch up from deltas; it reconnects and
            # refetches the state instead.
            user.subscribers.discard(q)
            try:
                q.put_nowait(("reset", {}))
            except queue.Full:
                pass

    # --- hosts -----------------------------------------------------------

    def touch_host(self, name, host):
        """Register or refresh a plugin's host. Returns (host_id, known)."""
        if not isinstance(host, dict):
            return None, False
        host_id = host.get("id")
        if not isinstance(host_id, str) or not HOST_ID.match(host_id):
            return None, False
        with self.lock:
            user = self.user(name)
            record = user.hosts.get(host_id)
            known = record is not None
            if record is None:
                if len(user.hosts) >= MAX_HOSTS_PER_USER:
                    self._drop_oldest_offline_host(user)
                kind = host.get("kind") if host.get("kind") in HOST_KINDS else "server"
                record = user.hosts[host_id] = {
                    "id": host_id,
                    "machine": str(host.get("machine") or "machine")[:64],
                    "kind": kind,
                    "version": str(host.get("version") or "")[:32],
                    "started": host.get("started") if isinstance(host.get("started"), (int, float)) else None,
                    "online": False,
                    "lastSeen": 0.0,
                }
            record["lastSeen"] = now()
            if not record["online"]:
                record["online"] = True
                log("host online user=%s machine=%s kind=%s" % (name, record["machine"], record["kind"]))
                self._emit(user, "host", dict(record))
            return host_id, known

    def _drop_oldest_offline_host(self, user):
        offline = [h for h in user.hosts.values() if not h["online"]]
        if offline:
            oldest = min(offline, key=lambda h: h["lastSeen"])
            self._remove_host(user, oldest["id"])

    def _remove_host(self, user, host_id):
        user.hosts.pop(host_id, None)
        for sid in [s.id for s in user.sessions.values() if s.host_id == host_id]:
            user.sessions.pop(sid, None)
            self._emit(user, "op", {"op": "remove", "sessionID": sid})
        user.commands.pop(host_id, None)

    def host_bye(self, name, host_id):
        with self.lock:
            user = self.user(name)
            record = user.hosts.get(host_id)
            if record and record["online"]:
                record["online"] = False
                record["lastSeen"] = now()
                self._emit(user, "host", dict(record))

    # --- ops -------------------------------------------------------------

    def apply(self, name, host_id, ops):
        applied = 0
        with self.lock:
            user = self.user(name)
            for op in ops if isinstance(ops, list) else []:
                normalized = self._apply_one(user, host_id, op)
                if normalized is not None:
                    applied += 1
                    normalized["hostId"] = host_id
                    self._emit(user, "op", normalized)
            self._enforce_session_cap(user)
        return applied

    def _session(self, user, host_id, sid):
        session = user.sessions.get(sid)
        if session is None:
            session = user.sessions[sid] = Session(sid, host_id)
        elif session.host_id != host_id:
            # Resumed in another window or on another machine: the newest
            # publisher owns it, and commands go there.
            session.host_id = host_id
        user.sessions.move_to_end(sid)
        return session

    def _apply_one(self, user, host_id, op):
        if not isinstance(op, dict):
            return None
        kind = op.get("op")
        sid = op.get("sessionID")
        if not isinstance(sid, str) or not SESSION_ID.match(sid):
            return None

        if kind == "remove":
            if user.sessions.pop(sid, None) is None:
                return None
            return {"op": "remove", "sessionID": sid}

        session = self._session(user, host_id, sid)

        if kind == "session":
            fields = clean(op.get("session"), SESSION_FIELDS)
            if fields.get("status") not in STATUSES:
                fields.pop("status", None)
            session.meta.update(fields)
            return {"op": "session", "sessionID": sid, "session": fields}

        if kind == "status":
            status = op.get("status")
            if status not in STATUSES:
                return None
            session.meta["status"] = status
            detail = op.get("detail")
            if isinstance(detail, str):
                session.meta["detail"] = detail[:800]
            else:
                session.meta.pop("detail", None)
            out = {"op": "status", "sessionID": sid, "status": status}
            if "detail" in session.meta:
                out["detail"] = session.meta["detail"]
            return out

        if kind == "snapshot":
            fields = clean(op.get("session"), SESSION_FIELDS)
            if fields.get("status") not in STATUSES:
                fields.pop("status", None)
            session.meta.update(fields)
            session.messages = OrderedDict()
            for raw in (op.get("messages") or [])[-MAX_MESSAGES:]:
                if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not MESSAGE_ID.match(raw["id"]):
                    continue
                header = clean(raw, MESSAGE_FIELDS)
                if header.get("role") not in ROLES:
                    continue
                message = session.message(raw["id"], header["role"])
                message.update(header)
                for part in raw.get("parts") or []:
                    self._merge_part(message, part)
            return {"op": "snapshot", "sessionID": sid, "session": fields, "messages": session.export()}

        if kind == "message":
            raw = op.get("message")
            if not isinstance(raw, dict) or not isinstance(raw.get("id"), str) or not MESSAGE_ID.match(raw["id"]):
                return None
            header = clean(raw, MESSAGE_FIELDS)
            role = header.get("role", "assistant")
            if role not in ROLES:
                return None
            message = session.message(raw["id"], role)
            message.update(header)
            return {"op": "message", "sessionID": sid, "message": dict(header, id=raw["id"])}

        mid = op.get("messageID")
        if not isinstance(mid, str) or not MESSAGE_ID.match(mid):
            return None

        if kind == "part":
            message = session.message(mid)
            part = self._merge_part(message, op.get("part"))
            if part is None:
                return None
            return {"op": "part", "sessionID": sid, "messageID": mid, "part": dict(part)}

        if kind == "append":
            key = op.get("key")
            text = op.get("text")
            part_kind = op.get("kind")
            if not isinstance(key, str) or not PART_KEY.match(key) or not isinstance(text, str) or part_kind not in ("text", "reasoning"):
                return None
            message = session.message(mid)
            part = message["parts"].get(key)
            if part is None:
                part = message["parts"][key] = {"key": key, "kind": part_kind, "text": "", "done": False}
            current = part.get("text", "")
            if len(current) >= MAX_PART_TEXT:
                part["truncated"] = True
                return None
            part["text"] = current + text[: MAX_PART_TEXT - len(current)]
            return {"op": "append", "sessionID": sid, "messageID": mid, "key": key, "kind": part_kind, "text": text}

        return None

    def _merge_part(self, message, raw):
        if not isinstance(raw, dict):
            return None
        key = raw.get("key")
        if not isinstance(key, str) or not PART_KEY.match(key):
            return None
        fields = clean(raw, PART_FIELDS)
        kind = fields.get("kind")
        if kind is not None and kind not in KINDS:
            return None
        part = message["parts"].get(key)
        if part is None:
            part = message["parts"][key] = {"key": key, "kind": kind or key.split(":", 1)[0]}
        part.update(fields)
        return part

    def _enforce_session_cap(self, user):
        while len(user.sessions) > MAX_SESSIONS_PER_USER:
            # Oldest first, but never one that is generating right now.
            victim = next((s for s in user.sessions.values() if s.meta.get("status") != "running"), None)
            if victim is None:
                break
            user.sessions.pop(victim.id)
            self._emit(user, "op", {"op": "remove", "sessionID": victim.id})

    # --- commands --------------------------------------------------------

    def queue_command(self, name, sid, kind, text=None):
        with self.lock:
            user = self.user(name)
            session = user.sessions.get(sid)
            if session is None:
                return None, "No such session."
            host = user.hosts.get(session.host_id)
            if not host or not host["online"]:
                return None, "That machine is offline, so it cannot take a prompt right now."
            command = {"id": "cmd_" + secrets.token_hex(8), "type": kind, "sessionID": sid}
            if text is not None:
                command["text"] = text
            user.commands.setdefault(session.host_id, deque()).append(command)
            user.pending[command["id"]] = (now(), session.host_id, sid, kind)
            self.changed.notify_all()
            log("command queued user=%s type=%s" % (name, kind))
            return command["id"], None

    def take_commands(self, name, host_id, wait):
        deadline = now() + max(0.0, min(wait, 25.0))
        with self.lock:
            user = self.user(name)
            while True:
                pending = user.commands.get(host_id)
                if pending:
                    commands = list(pending)
                    pending.clear()
                    return commands
                remaining = deadline - now()
                if remaining <= 0:
                    return []
                self.changed.wait(min(remaining, 5.0))
                record = user.hosts.get(host_id)
                if record is not None:
                    record["lastSeen"] = now()

    def report_results(self, name, results):
        with self.lock:
            user = self.user(name)
            for result in results if isinstance(results, list) else []:
                if not isinstance(result, dict):
                    continue
                entry = user.pending.pop(str(result.get("id")), None)
                if entry is None:
                    continue
                payload = {
                    "id": result.get("id"),
                    "sessionID": entry[2],
                    "type": entry[3],
                    "ok": bool(result.get("ok")),
                }
                if not payload["ok"]:
                    payload["error"] = str(result.get("error") or "The machine could not run it.")[:300]
                self._emit(user, "command", payload)

    # --- views -----------------------------------------------------------

    def state(self, name):
        with self.lock:
            user = self.user(name)
            hosts = {h_id: dict(h) for h_id, h in user.hosts.items()}
            return {
                "user": name,
                "epoch": self.epoch,
                "hosts": list(hosts.values()),
                "sessions": [s.summary(user.hosts) for s in reversed(user.sessions.values())],
            }

    def session_view(self, name, sid):
        with self.lock:
            user = self.user(name)
            session = user.sessions.get(sid)
            if session is None:
                return None
            return {"session": session.summary(user.hosts), "messages": session.export()}

    # --- housekeeping ----------------------------------------------------

    def sweep(self):
        cutoff = now()
        with self.lock:
            for name, user in self.users.items():
                for host in list(user.hosts.values()):
                    if host["online"] and cutoff - host["lastSeen"] > HOST_TIMEOUT:
                        host["online"] = False
                        log("host offline user=%s machine=%s kind=%s" % (name, host["machine"], host["kind"]))
                        self._emit(user, "host", dict(host))
                    if not host["online"] and cutoff - host["lastSeen"] > OFFLINE_RETENTION:
                        self._remove_host(user, host["id"])
                for cid, (queued, host_id, sid, kind) in list(user.pending.items()):
                    if cutoff - queued > COMMAND_TIMEOUT:
                        user.pending.pop(cid, None)
                        pending = user.commands.get(host_id)
                        if pending:
                            user.commands[host_id] = deque(c for c in pending if c["id"] != cid)
                        self._emit(user, "command", {
                            "id": cid, "sessionID": sid, "type": kind, "ok": False,
                            "error": "The machine did not pick it up in time.",
                        })


class Relay:
    def __init__(self, keys, tokens, web_dir, insecure_cookie=False):
        self.keys = keys
        self.tokens = tokens
        self.store = Store()
        self.web_dir = web_dir
        self.insecure_cookie = insecure_cookie
        self.failures = {}
        self.failures_lock = threading.Lock()
        self.web_files = set()
        if web_dir and os.path.isdir(web_dir):
            self.web_files = {f for f in os.listdir(web_dir) if WEB_FILE.match(f)}

    def login_allowed(self, ip):
        with self.failures_lock:
            recent = self.failures.get(ip)
            if not recent:
                return True
            while recent and now() - recent[0] > LOGIN_WINDOW:
                recent.popleft()
            return len(recent) < LOGIN_FAILURES

    def login_failed(self, ip):
        with self.failures_lock:
            self.failures.setdefault(ip, deque()).append(now())


def make_handler(relay):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "tellico-relay"
        sys_version = ""

        def log_message(self, format, *args):  # noqa: A002 -- base name
            pass

        # --- plumbing ----------------------------------------------------

        def client_ip(self):
            # Trust the proxy's header only when the proxy is this host.
            if self.client_address[0] in ("127.0.0.1", "::1"):
                forwarded = self.headers.get("X-Forwarded-For", "")
                if forwarded:
                    return forwarded.split(",")[0].strip()
            return self.client_address[0]

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

        def read_json(self, limit):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length < 0 or length > limit:
                self.close_connection = True
                self.fail(413, "Request too large.")
                return None
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw or b"{}")
            except ValueError:
                self.fail(400, "Invalid JSON.")
                return None
            if not isinstance(payload, dict):
                self.fail(400, "Expected an object.")
                return None
            return payload

        def bearer_user(self):
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return None
            user, _digest = relay.keys.lookup(header[7:].strip())
            return user

        def cookie_token(self):
            for part in self.headers.get("Cookie", "").split(";"):
                name, _, value = part.strip().partition("=")
                if name == COOKIE:
                    return value
            return None

        def phone_user(self):
            entry = relay.tokens.resolve(self.cookie_token())
            if not entry:
                return None
            user, key_digest, _expires = entry
            # A revoked or rotated key signs its phones out too.
            if relay.keys.user_for_digest(key_digest) != user:
                return None
            return user

        def same_origin_write(self):
            # The app always sends this; a cross-site form cannot.
            return self.headers.get("X-Tellico") == "1"

        def cookie_header(self, token, max_age):
            secure = "" if relay.insecure_cookie else "; Secure"
            return "%s=%s; Path=%s; HttpOnly; SameSite=Strict; Max-Age=%d%s" % (
                COOKIE, token, PREFIX, max_age, secure)

        # --- routing -----------------------------------------------------

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path = urlsplit(self.path).path
            if path == PREFIX:
                self.send_bytes(308, b"", "text/plain", {"Location": PREFIX + "/"})
                return
            if not path.startswith(PREFIX + "/"):
                self.fail(404, "Not found.")
                return
            rest = path[len(PREFIX) + 1:]
            if rest == "healthz":
                with relay.store.lock:
                    hosts = sum(1 for u in relay.store.users.values() for h in u.hosts.values() if h["online"])
                self.send_json(200, {"ok": True, "epoch": relay.store.epoch, "hostsOnline": hosts})
                return
            if rest.startswith("api/"):
                self.api_get(rest[4:])
                return
            self.static(rest or "index.html")

        def do_POST(self):
            path = urlsplit(self.path).path
            if not path.startswith(PREFIX + "/"):
                self.fail(404, "Not found.")
                return
            rest = path[len(PREFIX) + 1:]
            if rest.startswith("agent/"):
                self.agent_post(rest[6:])
            elif rest.startswith("api/"):
                self.api_post(rest[4:])
            else:
                self.fail(404, "Not found.")

        def static(self, name):
            if name not in relay.web_files:
                # Unknown paths get the app, so a deep link still opens it.
                name = "index.html"
                if name not in relay.web_files:
                    self.fail(404, "Not found.")
                    return
            with open(os.path.join(relay.web_dir, name), "rb") as handle:
                body = handle.read()
            if name.endswith(".webmanifest"):
                content_type = "application/manifest+json"
            else:
                content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type.endswith("javascript"):
                content_type += "; charset=utf-8"
            # Revalidated each load, so an update reaches phones at once.
            self.send_bytes(200, body, content_type, cache="no-cache")

        # --- the plugin's side ---------------------------------------------

        def agent_post(self, route):
            name = self.bearer_user()
            if not name:
                self.fail(401, "Unknown or revoked key.")
                return
            limit = MAX_PUBLISH_BODY if route == "publish" else MAX_SMALL_BODY
            payload = self.read_json(limit)
            if payload is None:
                return
            store = relay.store
            host_id, known = store.touch_host(name, payload.get("host"))
            if not host_id:
                self.fail(400, "Missing host.")
                return
            epoch = payload.get("epoch")
            # A plugin that last spoke to a previous relay process resends
            # everything; so does one this relay has never heard from.
            resync = epoch is not None and (epoch != store.epoch or not known)

            if route == "publish":
                applied = store.apply(name, host_id, payload.get("ops"))
                self.send_json(200, {"epoch": store.epoch, "resync": resync, "applied": applied})
            elif route == "poll":
                store.report_results(name, payload.get("results"))
                if resync:
                    self.send_json(200, {"epoch": store.epoch, "resync": True, "commands": []})
                    return
                wait = payload.get("wait")
                wait = float(wait) if isinstance(wait, (int, float)) else 0.0
                commands = store.take_commands(name, host_id, wait)
                self.send_json(200, {"epoch": store.epoch, "resync": False, "commands": commands})
            elif route == "bye":
                store.host_bye(name, host_id)
                self.send_json(200, {"epoch": store.epoch})
            else:
                self.fail(404, "Not found.")

        # --- the phone's side ----------------------------------------------

        def api_get(self, route):
            name = self.phone_user()
            if not name:
                self.fail(401, "Sign in first.")
                return
            if route == "me":
                self.send_json(200, {"user": name})
            elif route == "state":
                self.send_json(200, relay.store.state(name))
            elif route.startswith("session/"):
                sid = route[len("session/"):]
                view = relay.store.session_view(name, sid) if SESSION_ID.match(sid) else None
                if view is None:
                    self.fail(404, "No such session.")
                else:
                    self.send_json(200, view)
            elif route == "events":
                self.events(name)
            else:
                self.fail(404, "Not found.")

        def api_post(self, route):
            if route == "login":
                self.login()
                return
            if not self.same_origin_write():
                self.fail(403, "Missing X-Tellico header.")
                return
            if route == "logout":
                relay.tokens.revoke(self.cookie_token())
                self.send_json(200, {"ok": True}, {"Set-Cookie": self.cookie_header("", 0)})
                return
            name = self.phone_user()
            if not name:
                self.fail(401, "Sign in first.")
                return
            match = re.match(r"^session/(ses_[A-Za-z0-9_-]{1,80})/(prompt|interrupt)$", route)
            if not match:
                self.fail(404, "Not found.")
                return
            payload = self.read_json(MAX_SMALL_BODY)
            if payload is None:
                return
            sid, action = match.groups()
            text = None
            if action == "prompt":
                text = payload.get("text")
                if not isinstance(text, str) or not text.strip():
                    self.fail(400, "Write something first.")
                    return
                if len(text) > MAX_PROMPT:
                    self.fail(413, "That prompt is too long.")
                    return
            command_id, error = relay.store.queue_command(name, sid, action, text)
            if error:
                self.fail(409, error)
            else:
                self.send_json(202, {"commandID": command_id})

        def login(self):
            ip = self.client_ip()
            if not relay.login_allowed(ip):
                self.fail(429, "Too many attempts. Wait a few minutes.")
                return
            if not self.same_origin_write():
                self.fail(403, "Missing X-Tellico header.")
                return
            payload = self.read_json(4096)
            if payload is None:
                return
            key = payload.get("key")
            user, digest = relay.keys.lookup(key.strip() if isinstance(key, str) else "")
            if not user:
                relay.login_failed(ip)
                log("sign-in refused ip=%s" % ip)
                self.fail(401, "That key is not a Tellico gateway key, or it was revoked.")
                return
            token = relay.tokens.issue(user, digest)
            log("signed in user=%s ip=%s" % (user, ip))
            self.send_json(200, {"user": user}, {"Set-Cookie": self.cookie_header(token, TOKEN_LIFETIME)})

        def events(self, name):
            store = relay.store
            q = store.subscribe(name)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("X-Accel-Buffering", "no")
            for key, value in SECURITY_HEADERS.items():
                self.send_header(key, value)
            self.end_headers()

            def chunk(data):
                self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                self.wfile.flush()

            try:
                chunk(b"retry: 3000\nevent: hello\ndata: %s\n\n" % json.dumps({"epoch": store.epoch}).encode())
                while True:
                    try:
                        kind, payload = q.get(timeout=15)
                    except queue.Empty:
                        chunk(b": ping\n\n")
                        if self.phone_user() != name:
                            break
                        continue
                    chunk(b"event: %s\ndata: %s\n\n" % (kind.encode(), json.dumps(payload, separators=(",", ":")).encode()))
                    if kind == "reset":
                        break
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                store.unsubscribe(name, q)
                try:
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except OSError:
                    pass
                self.close_connection = True

    return Handler


def sweeper(store, stop):
    while not stop.wait(5.0):
        try:
            store.sweep()
        except Exception as error:  # Housekeeping must never take the relay down.
            log("sweep failed: %r" % (error,))


def main():
    config_home = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    bind = _env("TELLICO_RELAY_BIND", "127.0.0.1")
    port = int(_env("TELLICO_RELAY_PORT", "4100"))
    keys_path = _env("TELLICO_GATEWAY_KEYS", os.path.join(config_home, "tellico-gateway/keys"))
    state_dir = _env("TELLICO_RELAY_STATE_DIR", os.path.join(config_home, "tellico-relay"))
    web_dir = _env("TELLICO_RELAY_WEB", os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"))
    insecure = os.environ.get("TELLICO_RELAY_INSECURE_COOKIE") == "1"

    os.makedirs(state_dir, mode=0o700, exist_ok=True)
    relay = Relay(Keys(keys_path), Tokens(os.path.join(state_dir, "tokens")), web_dir, insecure)
    if not relay.web_files:
        log("warning: no web app found in %s" % web_dir)

    stop = threading.Event()
    threading.Thread(target=sweeper, args=(relay.store, stop), daemon=True).start()

    server = ThreadingHTTPServer((bind, port), make_handler(relay))
    server.daemon_threads = True
    log("listening on http://%s:%d%s/ keys=%s epoch=%s" % (bind, port, PREFIX, keys_path, relay.store.epoch))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()


if __name__ == "__main__":
    main()
