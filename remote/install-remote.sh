#!/bin/sh
# Install the phone-facing Tellico OpenCode server on this host.
#
# This is the third way in. The tunnel gives a terminal on your own machine and
# the gateway gives other people an API key; this one gives *you* a browser --
# typically a phone -- a live view of sessions you can read and steer, with the
# same agents, plugins and prompts as the TUI.
#
# What it installs is one supervised "opencode-tellico serve" on loopback. The
# web app and the v2 API it serves are OpenCode's own; nothing here reimplements
# a client. Reaching it from outside is the reverse proxy's job: see
# remote/caddy/Caddyfile.example and "tellico-remote caddy".
#
# It sits on top of the client install and, by default, routes sessions through
# the gateway on loopback, so remote work is admission-controlled and accounted
# like every other user's. It never restarts the tunnel or the gateway, so a
# live session elsewhere is safe while this runs.
set -eu

repo_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
client_dir="$config_home/tellico-qwen"
gateway_dir="$config_home/tellico-gateway"
config_dir="$config_home/tellico-remote"
env_file="$config_dir/remote.env"
password_file="$config_dir/password"
bcrypt_file="$config_dir/password.bcrypt"
bin_dir="$HOME/.local/bin"
unit_dir="$config_home/systemd/user"
unit_name=tellico-remote.service

start=1
rotate=0
want_bind=''
want_port=''
want_workspace=''
want_connection=''
want_gateway_url=''
want_public_url=''
want_gateway_user=''

usage() {
  cat >&2 <<'USAGE'
usage: remote/install-remote.sh [options]

  --port PORT          loopback port for the server (default: 4096)
  --bind ADDR          address to listen on (default: 127.0.0.1)
  --workspace DIR      directory sessions open in (default: ~/tellico-remote-work)
  --connection MODE    how sessions reach the models: gateway or tunnel
                       (default: gateway when one is installed here, else the
                       connection install.sh set up)
  --gateway-url URL    base URL for --connection gateway
                       (default: the local gateway, http://127.0.0.1:PORT/v1)
  --gateway-user NAME  gateway user whose key the server uses (default: remote)
  --public-url URL     the https:// origin the reverse proxy publishes, used by
                       "tellico-remote pair" and shown by "status"
  --rotate-password    replace the server password, then re-paste the Caddy
                       snippet and pair the phone again
  --no-start           install files only; do not start the service
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case $1 in
    --port) want_port=${2:?--port needs a value}; shift 2 ;;
    --bind) want_bind=${2:?--bind needs a value}; shift 2 ;;
    --workspace) want_workspace=${2:?--workspace needs a value}; shift 2 ;;
    --connection) want_connection=${2:?--connection needs a value}; shift 2 ;;
    --gateway-url) want_gateway_url=${2:?--gateway-url needs a value}; shift 2 ;;
    --gateway-user) want_gateway_user=${2:?--gateway-user needs a value}; shift 2 ;;
    --public-url) want_public_url=${2:?--public-url needs a value}; shift 2 ;;
    --rotate-password) rotate=1; shift ;;
    --no-start) start=0; shift ;;
    -h|--help) usage ;;
    *) echo "install-remote.sh: unknown option $1" >&2; usage ;;
  esac
done

fail() {
  echo "install-remote.sh: $1" >&2
  shift
  for line in "$@"; do
    echo "  $line" >&2
  done
  exit 1
}

# --- prerequisites -----------------------------------------------------------

command -v python3 >/dev/null 2>&1 ||
  fail 'python3 is required but not on PATH.'

[ -x "$bin_dir/opencode-tellico" ] ||
  fail 'the client side is not installed yet.' \
    'This server is the launcher with no TUI, so it needs the launcher. From the repo root:' \
    '  ./install.sh' \
    'Then rerun this script.'

grep -q '= serve' "$bin_dir/opencode-tellico" 2>/dev/null ||
  fail 'the installed launcher predates its serve mode.' \
    'Update it, keeping the running tunnel:' \
    '  ./install.sh --no-start'

# shellcheck source=../lib/checks.sh
. "$repo_dir/lib/checks.sh"

major=$(tellico_opencode_major)
case $major in
  ''|*[!0-9]*)
    fail 'cannot tell which OpenCode this is.' \
      'Check that "opencode --version" works for this user.'
    ;;
  1)
    fail 'OpenCode 1 has no web app, no v2 API and no pairing.' \
      'The phone client is OpenCode 2 only. Upgrade, then rerun:' \
      '  opencode upgrade --major'
    ;;
esac

# --- existing settings become the defaults, so reruns are safe ---------------

if [ -r "$env_file" ]; then
  # shellcheck disable=SC1090
  . "$env_file"
fi

installed_connection=tunnel
if [ -r "$client_dir/client.env" ]; then
  # shellcheck disable=SC1090
  . "$client_dir/client.env"
  installed_connection=${TELLICO_MODE:-tunnel}
fi

gateway_port=4000
gateway_here=0
if [ -r "$gateway_dir/gateway.env" ]; then
  # shellcheck disable=SC1090
  . "$gateway_dir/gateway.env"
  gateway_port=${TELLICO_GATEWAY_PORT:-4000}
  gateway_here=1
fi

bind=${want_bind:-${TELLICO_REMOTE_BIND:-127.0.0.1}}
port=${want_port:-${TELLICO_REMOTE_PORT:-4096}}
workspace=${want_workspace:-${TELLICO_REMOTE_WORKSPACE:-$HOME/tellico-remote-work}}
gateway_user=${want_gateway_user:-${TELLICO_REMOTE_GATEWAY_USER:-remote}}

# A local gateway is preferred over the raw tunnel: it caps and accounts what
# the remote sessions take, the same way it does for everyone else.
if [ -n "$want_connection" ]; then
  connection=$want_connection
elif [ -n "${TELLICO_REMOTE_CONNECTION:-}" ]; then
  connection=$TELLICO_REMOTE_CONNECTION
elif [ "$gateway_here" -eq 1 ]; then
  connection=gateway
else
  connection=$installed_connection
fi

case $connection in
  tunnel|gateway) ;;
  *) fail "--connection must be tunnel or gateway, got '$connection'" ;;
esac
case $port in ''|*[!0-9]*) fail "--port must be a number, got '$port'" ;; esac
case $bind in
  127.0.0.1|localhost|::1) ;;
  *)
    echo 'install-remote.sh: warning: a bind other than loopback puts an' >&2
    echo '  endpoint that can run commands on this host onto the network with' >&2
    echo "  no TLS. Prefer --bind 127.0.0.1 behind the reverse proxy." >&2
    ;;
esac

gateway_url=${want_gateway_url:-${TELLICO_CONNECTION_GATEWAY_URL:-}}
if [ "$connection" = gateway ] && [ -z "$gateway_url" ]; then
  # Loopback by default: the published URL would leave this host and come back
  # through TLS and the proxy for nothing.
  gateway_url="http://127.0.0.1:$gateway_port/v1"
fi

# The origin the proxy publishes. config/gateway-url is the repository's record
# of where this deployment answers, so it is the right default.
public_url=${want_public_url:-${TELLICO_REMOTE_PUBLIC_URL:-}}
if [ -z "$public_url" ] && [ -r "$repo_dir/config/gateway-url" ]; then
  public_url=$(sed -n '1s|/v1/*$||p' "$repo_dir/config/gateway-url")
fi

# --- secrets ----------------------------------------------------------------

mkdir -p "$config_dir"
chmod 700 "$config_dir"
umask 077

if [ "$rotate" -eq 1 ]; then
  rm -f "$password_file" "$bcrypt_file"
fi

if [ ! -s "$password_file" ]; then
  # One secret guards both locks: the proxy's check at the edge and OpenCode's
  # own. A word passphrase is strong at this length and still typeable once on
  # a phone keyboard, which a random string is not.
  words=''
  for dict in /usr/share/dict/words /usr/share/dict/american-english; do
    if [ -r "$dict" ] && [ "$(grep -c -x '[a-z]\{4,8\}' "$dict" 2>/dev/null || echo 0)" -ge 4096 ]; then
      words=$dict
      break
    fi
  done
  if [ -n "$words" ]; then
    grep -x '[a-z]\{4,8\}' "$words" | sort -u |
      shuf -n 6 --random-source=/dev/urandom | paste -sd- - >"$password_file"
  else
    python3 -c 'import secrets; print(secrets.token_urlsafe(30))' >"$password_file"
  fi
  chmod 600 "$password_file"
  echo "Generated $password_file"
fi

# bcrypt for the proxy, so the plaintext never enters a proxy config file.
if command -v caddy >/dev/null 2>&1; then
  if [ ! -s "$bcrypt_file" ] || [ "$password_file" -nt "$bcrypt_file" ]; then
    caddy hash-password --algorithm bcrypt \
      --plaintext "$(cat "$password_file")" >"$bcrypt_file"
    chmod 600 "$bcrypt_file"
    echo "Wrote     $bcrypt_file"
  fi
fi

# A key of its own, so the gateway's log and limits can tell remote sessions
# apart from this operator's own terminal.
if [ "$connection" = gateway ]; then
  key_file=$(tellico_key_file "$client_dir" "$installed_connection" gateway)
  if [ ! -s "$key_file" ]; then
    if [ "$gateway_here" -eq 1 ] && [ -x "$bin_dir/tellico-gateway" ]; then
      if "$bin_dir/tellico-gateway" list-users 2>/dev/null |
        awk 'NR>1 && $1 == user { found = 1 } END { exit !found }' user="$gateway_user"; then
        fail "gateway user '$gateway_user' already holds a key, but $key_file is missing." \
          'A key is shown once only, so mint a fresh one:' \
          "  tellico-gateway revoke $gateway_user" \
          "  tellico-gateway add-user $gateway_user 2" \
          "then write it to $key_file with mode 0600, or pass --gateway-user NAME."
      fi
      # Two slots: one for the lead, one for a worker it dispatches to.
      "$bin_dir/tellico-gateway" add-user "$gateway_user" 2 |
        grep -o 'sk-tellico-[A-Za-z0-9_-]*' | head -n 1 >"$key_file"
      [ -s "$key_file" ] || { rm -f "$key_file"; fail 'minting a gateway key failed.'; }
      chmod 600 "$key_file"
      echo "Minted    $key_file (gateway user $gateway_user)"
    else
      fail "no key for the gateway connection at $key_file." \
        'On a host without the gateway, get a key from whoever runs it and:' \
        "  umask 077; printf '%s\\n' sk-tellico-... > $key_file" \
        'Or install against the tunnel instead:' \
        '  remote/install-remote.sh --connection tunnel'
    fi
  fi
fi

# --- settings ---------------------------------------------------------------

cat >"$env_file" <<EOF
# Generated by remote/install-remote.sh. Edit, then: tellico-remote restart
TELLICO_REMOTE_BIND="$bind"
TELLICO_REMOTE_PORT="$port"
TELLICO_REMOTE_WORKSPACE="$workspace"
TELLICO_REMOTE_GATEWAY_USER="$gateway_user"
TELLICO_REMOTE_PUBLIC_URL="$public_url"

# Which connection the sessions use, read straight by the launcher.
TELLICO_REMOTE_CONNECTION="$connection"
TELLICO_CONNECTION="$connection"
TELLICO_CONNECTION_GATEWAY_URL="$gateway_url"

# The server's own password. OpenCode asks for it as HTTP basic auth, and so
# does the reverse proxy in front: see "tellico-remote caddy". This file is the
# only place it is stored in the clear, which is why it is 0600.
OPENCODE_PASSWORD="$(cat "$password_file")"
EOF
chmod 600 "$env_file"
echo "Wrote     $env_file"

mkdir -p "$workspace"
echo "Workspace $workspace"

umask 022
mkdir -p "$bin_dir"
install -m 0755 "$repo_dir/remote/bin/tellico-remote" "$bin_dir/tellico-remote"
echo "Installed $bin_dir/tellico-remote"

# --- service -----------------------------------------------------------------

have_systemd_user() {
  command -v systemctl >/dev/null 2>&1 &&
    systemctl --user is-system-running >/dev/null 2>&1
}

if have_systemd_user; then
  mkdir -p "$unit_dir"
  sed \
    -e "s|__TELLICO_REMOTE_WORKSPACE__|$workspace|g" \
    -e "s|__TELLICO_REMOTE_ENV__|$env_file|g" \
    -e "s|__TELLICO_REMOTE_LAUNCHER__|$bin_dir/opencode-tellico|g" \
    -e "s|__TELLICO_REMOTE_PATH__|$bin_dir:$HOME/.opencode/bin:/usr/local/bin:/usr/bin:/bin|g" \
    "$repo_dir/systemd/$unit_name.in" >"$unit_dir/$unit_name"
  chmod 644 "$unit_dir/$unit_name"
  systemctl --user daemon-reload
  systemctl --user enable "$unit_name" >/dev/null
  echo "Enabled   $unit_dir/$unit_name"
  if ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q 'Linger=yes'; then
    echo
    echo 'This user has no linger, so the server stops when you log out. For an'
    echo 'always-on endpoint:'
    echo "  sudo loginctl enable-linger $(id -un)"
  fi
else
  echo 'No systemd user manager here, so the server has no service unit.'
  echo 'Run it in the foreground (or under your own supervisor) with:'
  echo '  tellico-remote run'
  start=0
fi

if [ "$start" -eq 1 ]; then
  echo
  if ! "$bin_dir/tellico-remote" restart; then
    echo >&2
    echo 'The server did not come up. Look at:' >&2
    echo '  tellico-remote doctor' >&2
    echo '  journalctl --user -u tellico-remote -n 50' >&2
    exit 1
  fi
  "$bin_dir/tellico-remote" status
fi

echo
echo 'Next, publish it. The server is on loopback only until a reverse proxy'
echo 'fronts it with TLS and the same password:'
echo '  tellico-remote caddy        # the snippet to add, with the hash filled in'
echo
echo 'Then pair the phone:'
echo '  tellico-remote pair         # a one-time link; open it on the phone'
