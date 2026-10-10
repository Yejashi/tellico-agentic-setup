// Hard-blocks the model from reading this setup's own credentials, and the
// usual secret files of whatever repository the session is working in. The pi
// counterpart of plugins/secret-guard/, and the same allowlist-first logic.
//
// It matters more here than it does under OpenCode. Pi has no permission
// system at all -- "it does not ask for approval before every tool call", as
// its own security guide puts it -- so nothing else stands between the model
// and `cat ~/.config/tellico-qwen/api-key`. And pi reaches the key through
// `apiKey: "!cat .../api-key"` in models.json, so the path is in the
// configuration the model can read.
//
// Pi's tool_call event can block a call outright, and a throwing handler also
// blocks it as a fail-safe, so a bug here closes the tool rather than opening
// it. The event carries `toolName` and `input`; tool and argument names are
// pi's own, so `read`, `edit`, `write`, `grep`, `find` and `ls` all take
// `path`, and `bash` takes `command`.
//
// Allowlist-first, like every other check in this repository: a form this
// cannot recognise (a shell variable holding the path, say) is allowed through
// rather than guessed at. Under-enforcing is the intended failure mode.

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const HOME = process.env.HOME || "";

// This setup's own secrets. Matched on the tail of the path, so every
// spelling of the same file is caught: absolute, ~-relative, or $HOME.
const TELLICO_SECRET_RE = /tellico-qwen\/(api-key|client\.env)(\.[A-Za-z0-9_.-]+)?$/;

// Secrets of the repository under work. .env.example and friends are never
// secret-bearing and stay readable.
const ENV_EXAMPLE_RE = /(^|\/)\.env\.(example|sample|template)(\.[A-Za-z0-9_-]+)?$/;
const ENV_SECRET_RE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;

// Private halves of SSH keys. The tunnel's device key is as sensitive as the
// API key. .pub is public by definition and stays readable.
const SSH_PRIVATE_RE = /(^|\/)\.ssh\/(id_[A-Za-z0-9_-]+|[A-Za-z0-9_.-]+_(rsa|dsa|ecdsa|ed25519))$/;

// A command only reads a file if it hands it to something that prints bytes.
const READ_UTIL_RE =
  /(^|[|&;(\s])(cat|bat|less|more|head|tail|grep|egrep|fgrep|rg|ag|awk|sed|sort|uniq|cut|nl|tr|xxd|od|strings|base64|cp|tee|dd|install|scp)([\s]|$)/;
const PY_OPEN_RE = /python[0-9.]*\s+-c|open\s*\(|readFileSync|read_text/;

// Tools that take a filesystem path in `path`.
const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);

function expandHome(path) {
  if (!HOME) return path;
  if (path.startsWith("~/")) return HOME + path.slice(1);
  if (path.startsWith("$HOME/")) return HOME + path.slice(5);
  if (path.startsWith("${HOME}/")) return HOME + path.slice(7);
  return path;
}

function secretKind(path) {
  if (!path) return null;
  const resolved = expandHome(path);
  if (TELLICO_SECRET_RE.test(resolved)) return "a Tellico credential";
  if (SSH_PRIVATE_RE.test(resolved)) return "an SSH private key";
  if (ENV_EXAMPLE_RE.test(resolved)) return null;
  if (ENV_SECRET_RE.test(resolved)) return "a .env secret file";
  return null;
}

// A word that merely looks like a secret path is not one. `grep -rn
// "tellico-qwen/api-key" .` names the path as a pattern to search for and
// reads nothing, while ~/.config/tellico-qwen/api-key is the file itself. The
// difference is whether the word resolves to something that exists, so that
// is the test. A path that does not exist has no bytes to leak.
function resolvesToFile(word) {
  const expanded = expandHome(word);
  try {
    const path = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    return existsSync(path);
  } catch {
    return false;
  }
}

// Whitespace-split is enough: a path that reaches a read utility as its own
// word is the case worth blocking, and an embedded one (open('.env')) is
// caught because the same split strips the quotes and brackets around it.
function commandSecretKind(command) {
  if (!command) return null;
  if (!READ_UTIL_RE.test(command) && !PY_OPEN_RE.test(command)) return null;

  for (const word of command.split(/[\s'"(),;|&><]+/)) {
    const kind = secretKind(word);
    if (kind && resolvesToFile(word)) return kind;
  }
  return null;
}

function stringArg(args, key) {
  if (!args || typeof args !== "object") return "";
  const value = args[key];
  return typeof value === "string" ? value : "";
}

const ADVICE =
  "Report that you need it rather than reading it; never quote a credential " +
  "into a report, a plan file or a commit.";

// Returns a block reason, or null to let the call through.
export function blockReason(toolName, args) {
  if (PATH_TOOLS.has(toolName)) {
    const path = stringArg(args, "path");
    const kind = secretKind(path);
    if (kind) return `${path} is ${kind}. ${ADVICE}`;
  }

  if (toolName === "bash" || toolName === "powershell") {
    const kind = commandSecretKind(stringArg(args, "command"));
    if (kind) return `this command reads ${kind}. ${ADVICE}`;
  }

  return null;
}

export default function (pi) {
  pi.on("tool_call", (event) => {
    const reason = blockReason(event?.toolName, event?.input);
    if (reason) return { block: true, reason: `[secret-guard] blocked: ${reason}` };
  });
}
