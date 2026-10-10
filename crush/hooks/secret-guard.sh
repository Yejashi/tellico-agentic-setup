#!/bin/sh
# Hard-blocks Crush from reading this setup's own credentials, and the usual
# secret files of whatever repository the session is working in. The Crush
# counterpart of plugins/secret-guard/ and pi/extensions/secret-guard/, and the
# same allowlist-first logic.
#
# Crush fires PreToolUse before every tool call. Exit 2 blocks the call and
# uses stderr as the reason the model sees; any other non-zero exit is a
# non-blocking warning, so a bug here lets the call through rather than
# wedging the session. The hook needs no JSON parsing: Crush exports
# CRUSH_TOOL_NAME, CRUSH_TOOL_INPUT_FILE_PATH ("for file tools: the target
# file path") and CRUSH_TOOL_INPUT_COMMAND ("for bash calls: the shell command
# being run"), which is why this is POSIX sh and not a program with a
# toolchain. Keying on the normalised file path rather than on each tool's own
# argument also means a new file tool is covered the day Crush adds it.
#
# Scope, documented by Crush: PreToolUse fires only on the top-level agent's
# tool calls. That covers everything today because Crush has no subagents yet
# (PR 3098 is open); when it does, this stops covering them.
#
# Allowlist-first, like every other check in this repository: a form this
# cannot recognise (a shell variable holding the path, say) is allowed through
# rather than guessed at. Under-enforcing is the intended failure mode.

set -u

ADVICE='Report that you need it rather than reading it; never quote a credential into a report, a plan file or a commit.'

# This setup's own secrets, matched on the tail of the path so every spelling
# of the same file is caught. Then private SSH keys, then .env files -- but
# never .env.example and friends, which are not secret-bearing.
secret_kind() {
  case ${1:-} in
    '') return 1 ;;
  esac
  guard_path=$(expand_home "$1")
  if printf '%s' "$guard_path" |
    grep -Eq 'tellico-qwen/(api-key|client\.env)(\.[A-Za-z0-9_.-]+)?$'; then
    printf 'a Tellico credential'
    return 0
  fi
  if printf '%s' "$guard_path" |
    grep -Eq '(^|/)\.ssh/(id_[A-Za-z0-9_-]+|[A-Za-z0-9_.-]+_(rsa|dsa|ecdsa|ed25519))$'; then
    printf 'an SSH private key'
    return 0
  fi
  if printf '%s' "$guard_path" |
    grep -Eq '(^|/)\.env\.(example|sample|template)(\.[A-Za-z0-9_-]+)?$'; then
    return 1
  fi
  if printf '%s' "$guard_path" | grep -Eq '(^|/)\.env(\.[A-Za-z0-9_-]+)?$'; then
    printf 'a .env secret file'
    return 0
  fi
  return 1
}

expand_home() {
  case $1 in
    '~/'*) printf '%s/%s' "${HOME:-}" "${1#\~/}" ;;
    '$HOME/'*) printf '%s/%s' "${HOME:-}" "${1#\$HOME/}" ;;
    '${HOME}/'*) printf '%s/%s' "${HOME:-}" "${1#\$\{HOME\}/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

block() {
  printf '[secret-guard] blocked: %s. %s\n' "$1" "$ADVICE" >&2
  exit 2
}

# A file tool names its target directly.
if kind=$(secret_kind "${CRUSH_TOOL_INPUT_FILE_PATH:-}"); then
  block "$CRUSH_TOOL_INPUT_FILE_PATH is $kind"
fi

# A command only reads a file if it hands it to something that prints bytes.
command_line=${CRUSH_TOOL_INPUT_COMMAND:-}
if [ -n "$command_line" ]; then
  if printf '%s' "$command_line" | grep -Eq \
    '(^|[|&;(\ ])(cat|bat|less|more|head|tail|grep|egrep|fgrep|rg|ag|awk|sed|sort|uniq|cut|nl|tr|xxd|od|strings|base64|cp|tee|dd|install|scp)([\ ]|$)' ||
    printf '%s' "$command_line" |
      grep -Eq 'python[0-9.]*[[:space:]]+-c|open[[:space:]]*\(|readFileSync|read_text'; then
    # A word that merely looks like a secret path is not one. A grep for
    # "tellico-qwen/api-key" names the path as a pattern and reads nothing,
    # while the path itself is the file. The difference is whether the word
    # resolves to something that exists, so that is the test: a path that does
    # not exist has no bytes to leak.
    for word in $(printf '%s' "$command_line" | tr "\\'\"(),;|&><" ' '); do
      if kind=$(secret_kind "$word") && [ -f "$(expand_home "$word")" ]; then
        block "this command reads $kind"
      fi
    done
  fi
fi

exit 0
