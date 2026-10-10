#!/bin/sh
# Keeps raw HTML out of a Tellico session's context. Crush's fetch tool takes
# a format of text, markdown or html, and html returns the page byte for byte:
# a libgen search page came back at 90-115 KB, roughly 30k tokens, and three
# of them in one parallel batch took a session from 62k to 149k tokens in a
# single step. Crush decides whether to auto-summarize between steps from the
# previous step's usage, so nothing caught it: the request went out, the
# server rejected it against the 131072-token slot, and the summary request
# then failed the same way because it carries the whole history. That session
# was unrecoverable. Markdown of the same page keeps the text and the links at
# a fraction of the size.
#
# Two layers. The first html fetch in a session is rewritten to markdown and
# the model is told why. Crush applies updated_input as a shallow merge into
# the tool input, so {"format":"markdown"} is the whole patch and no JSON
# parsing is needed. Any later html request in the same session is blocked
# (exit 2, stderr is the reason) and pointed at agentic_fetch, which reads the
# page in a subagent and returns only what was asked for. That includes the
# siblings of the first one in a parallel batch, before the model has seen the
# note; they are retried as markdown, which is the cheaper outcome anyway.
#
# Only in a crush-tellico session: the fragment that registers this hook is
# sourced from the user's own crushrc, so a plain "crush" on another provider
# runs it too, and that is not ours to change. The launcher exports
# TELLICO_LEAD_NODE and Crush's hooks inherit its environment.
#
# Allowlist-first like secret-guard.sh: anything this cannot recognise, or a
# state file it cannot write, lets the call through unchanged.

set -u

[ -n "${TELLICO_LEAD_NODE:-}" ] || exit 0
[ "${CRUSH_TOOL_NAME:-}" = fetch ] || exit 0

payload=$(cat) || exit 0
printf '%s' "$payload" |
  grep -Eq '"format"[[:space:]]*:[[:space:]]*"[Hh][Tt][Mm][Ll]"' || exit 0

state_dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/tellico-fetch-guard.$(id -u)"
session=$(printf '%s' "${CRUSH_SESSION_ID:-}" | tr -c 'A-Za-z0-9_-' '_')
marker="$state_dir/$session"

if [ -n "${CRUSH_SESSION_ID:-}" ] && [ -e "$marker" ]; then
  printf '%s %s\n' \
    '[fetch-guard] blocked: fetch with format "html" was already rewritten to markdown once in this session; raw HTML can fill the 131072-token context in one batch and break the session.' \
    'Use format "markdown" or "text", or agentic_fetch to read a page through a subagent and get back only what you need.' >&2
  exit 2
fi

if [ -n "${CRUSH_SESSION_ID:-}" ]; then
  (umask 077 && mkdir -p "$state_dir" && : >"$marker") 2>/dev/null || true
fi

printf '%s\n' '{"updated_input":{"format":"markdown"},"context":"[fetch-guard] format \"html\" was rewritten to \"markdown\": raw HTML costs several times the tokens and can overflow this session'"'"'s 131072-token context. Use markdown or text, or agentic_fetch for large pages; another html request in this session will be blocked."}'
exit 0
