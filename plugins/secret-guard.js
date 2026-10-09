// Hard-blocks a worker from reading this setup's own credentials, and the
// usual secret files of whatever repository the session is working in.
//
// This cannot be done in config. OpenCode's permission schema gates edit,
// bash, webfetch, doom_loop and external_directory, but there is no
// pattern gate for the read tool at all, and permission.bash matches literal
// command strings rather than what a command resolves to. Both workers run
// "*": "allow", so without this plugin `read ~/.config/tellico-qwen/api-key`
// or `cat` of the same file succeeds, the key lands in the worker's report,
// and from there in the lead's context and possibly in .agent/PLANS.md on
// disk. A throw in tool.execute.before aborts the call instead.
//
// Allowlist-first, like every other check here: a form this cannot recognise
// (a shell variable holding the path, say) is allowed through rather than
// guessed at. Under-enforcing is the intended failure mode.

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

export const SecretGuardPlugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      const tool = (input && input.tool) || "";
      const args = output && output.args;

      if (tool === "read") {
        const filePath = stringArg(args, "filePath") || stringArg(args, "path");
        const kind = secretKind(filePath);
        if (kind) {
          throw new Error(
            `[secret-guard] blocked: ${filePath} is ${kind}. ` +
              "Report that you need it rather than reading it; never quote a " +
              "credential into a report, a plan file or a commit.",
          );
        }
      }

      if (tool === "bash") {
        const command = stringArg(args, "command");
        const kind = commandSecretKind(command);
        if (kind) {
          throw new Error(
            `[secret-guard] blocked: this command reads ${kind}. ` +
              "Report that you need it rather than reading it; never quote a " +
              "credential into a report, a plan file or a commit.",
          );
        }
      }
    },
  };
};

export default SecretGuardPlugin;
