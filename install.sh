#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ssh_host=${TELLICO_SSH_HOST:-tellico}
port0=${TELLICO_QWEN_PORT0:-18080}
port1=${TELLICO_QWEN_PORT1:-18081}
remote_key_path=${TELLICO_REMOTE_KEY_PATH:-/data/gclab/qwen38/secrets/api-key}
start_client=true
fix_path=false
# Empty until a flag, a previous install, or the user chooses one.
mode=
gateway_url=
api_key_file=
ssh_identity=${TELLICO_SSH_IDENTITY:-}

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
config_dir="$config_home/tellico-qwen"

# The gateway this repository is set up for, so a user needs only a key. An
# operator running their own gateway edits that one file; --gateway-url and
# TELLICO_GATEWAY_URL still win over it.
default_gateway_url=${TELLICO_GATEWAY_URL:-}
if [ -z "$default_gateway_url" ] && [ -r "$script_dir/config/gateway-url" ]; then
  default_gateway_url=$(sed -e 's/[[:space:]]*$//' -e '/^$/d' -e '1q' \
    "$script_dir/config/gateway-url")
fi

usage() {
  cat <<'EOF'
usage: ./install.sh [--gateway-url URL [--api-key-file PATH]]
                    [--ssh-host HOST] [--port0 PORT] [--port1 PORT]
                    [--remote-key-path PATH] [--fix-path] [--no-start]

Installs the Tellico OpenCode client for the current user, in one of two
modes. Run with no mode flag and it asks which one you want.

Gateway mode needs only an API key: no SSH, no cluster account, no tunnel.
The gateway URL is built in, so the key is the only thing to have at hand.

Tunnel mode forwards the private cluster endpoints over your own SSH
connection, and needs a Tellico account with an authorized key.

Both modes give the same dual-node session with the same two workers.

  --gateway        Gateway mode against the built-in URL
  --ssh, --tunnel  Tunnel mode over your own SSH connection
  --gateway-url URL
                   Gateway mode against a different base URL, for example
                   https://host.example.ts.net/v1
  --api-key-file PATH
                   File holding the gateway API key. Without it the key is
                   read from standard input when piped, or prompted for.
  --ssh-host HOST  SSH hostname or config alias (default: tellico)
  --ssh-identity PATH
                   Private key to authenticate with, passed as IdentityFile
                   with IdentitiesOnly. Use this when ~/.ssh/config names a
                   key ssh cannot use and you cannot edit it, which is the
                   case when home-manager or NixOS generates it.
  --remote-key-path PATH
                   Path to the model API key on the cluster
                   (default: /data/gclab/qwen38/secrets/api-key).
                   Set this when connecting under your own cluster account.
  --port0 PORT     Local port for tellico-compute0 (default: 18080)
  --port1 PORT     Local port for tellico-compute1 (default: 18081)
  --fix-path       Add ~/.local/bin to PATH in the login shell's profile,
                   if it is not there already
  --no-start       Install the files only: skip the connectivity checks, the
                   tunnel, and validation. Useful before this device has been
                   authorized on Tellico.
  -h, --help       Show this help
EOF
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --gateway)
      mode=gateway
      shift
      ;;
    --ssh|--tunnel)
      mode=tunnel
      shift
      ;;
    --gateway-url)
      [ "$#" -ge 2 ] || { echo 'install: --gateway-url requires a value' >&2; exit 2; }
      mode=gateway
      gateway_url=$2
      shift 2
      ;;
    --api-key-file)
      [ "$#" -ge 2 ] || { echo 'install: --api-key-file requires a value' >&2; exit 2; }
      api_key_file=$2
      shift 2
      ;;
    --ssh-host)
      [ "$#" -ge 2 ] || { echo 'install: --ssh-host requires a value' >&2; exit 2; }
      ssh_host=$2
      shift 2
      ;;
    --ssh-identity)
      [ "$#" -ge 2 ] || { echo 'install: --ssh-identity requires a value' >&2; exit 2; }
      ssh_identity=$2
      shift 2
      ;;
    --port0)
      [ "$#" -ge 2 ] || { echo 'install: --port0 requires a value' >&2; exit 2; }
      port0=$2
      shift 2
      ;;
    --port1)
      [ "$#" -ge 2 ] || { echo 'install: --port1 requires a value' >&2; exit 2; }
      port1=$2
      shift 2
      ;;
    --remote-key-path)
      [ "$#" -ge 2 ] || { echo 'install: --remote-key-path requires a value' >&2; exit 2; }
      remote_key_path=$2
      shift 2
      ;;
    --fix-path)
      fix_path=true
      shift
      ;;
    --no-start)
      start_client=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# A device that is already installed keeps its mode unless asked to change,
# so rerunning install.sh after a git pull never switches it by accident.
recorded_mode=
if [ -r "$config_dir/client.env" ]; then
  recorded_mode=$(sed -n "s/^TELLICO_MODE='\(.*\)'$/\1/p" "$config_dir/client.env")
fi

# Echoes a mode name. Takes one too, so that an answer and a fallback on EOF
# cannot disagree about what the default meant.
choose_mode() {
  default_mode=$1
  case $default_mode in
    gateway) default_choice=1 ;;
    *) default_choice=2 ;;
  esac
  echo 'How should this device reach the Tellico models?' >&2
  echo >&2
  echo '  1) API key     no SSH and no cluster account. You need a key from' >&2
  echo '                 whoever runs the gateway, and nothing else.' >&2
  echo '  2) SSH tunnel  for a Tellico account with an authorized key.' >&2
  echo >&2
  while :; do
    printf 'Choice [%s]: ' "$default_choice" >&2
    if ! IFS= read -r reply; then
      printf '%s\n' "$default_mode"
      return 0
    fi
    [ -n "$reply" ] || reply=$default_choice
    case $reply in
      1|api|key|gateway)
        printf 'gateway\n'
        return 0
        ;;
      2|ssh|tunnel)
        printf 'tunnel\n'
        return 0
        ;;
      *)
        echo 'Enter 1 or 2.' >&2
        ;;
    esac
  done
}

# A key file is only meaningful to gateway mode, so it names the mode too.
if [ -z "$mode" ] && [ -n "$api_key_file" ]; then
  mode=gateway
fi

if [ -z "$mode" ]; then
  if [ -n "$recorded_mode" ]; then
    mode=$recorded_mode
  elif [ -t 0 ]; then
    case $(choose_mode gateway) in
      gateway) mode=gateway ;;
      *) mode=tunnel ;;
    esac
    echo >&2
  else
    # Nobody to ask and nothing recorded: keep the historical default.
    mode=tunnel
  fi
fi

if [ "$mode" = gateway ] && [ -z "$gateway_url" ]; then
  gateway_url=$default_gateway_url
  if [ -z "$gateway_url" ]; then
    echo 'install: no gateway URL is configured for this checkout.' >&2
    echo 'Pass one with --gateway-url https://HOST/v1' >&2
    exit 2
  fi
fi

if [ "$mode" = tunnel ] && [ -n "$api_key_file" ]; then
  echo 'install: --api-key-file applies to gateway mode; pass --gateway too' >&2
  exit 2
fi

if [ "$mode" = gateway ]; then
  case $gateway_url in
    http://*|https://*) ;;
    *)
      echo 'install: --gateway-url must start with http:// or https://' >&2
      exit 2
      ;;
  esac
  case $gateway_url in
    *[\'\"\$\`]*|*' '*)
      echo 'install: --gateway-url may not contain quotes, spaces, $, or backticks' >&2
      exit 2
      ;;
  esac
  # Strip a trailing slash so joining /models or /node0 is predictable.
  gateway_url=${gateway_url%/}
  case $gateway_url in
    */v1) ;;
    *)
      echo "install: --gateway-url should end in /v1, got $gateway_url" >&2
      echo 'The operator hands out a base URL like https://HOST/v1.' >&2
      exit 2
      ;;
  esac
  case $gateway_url in
    https://*|http://127.0.0.1*|http://localhost*) ;;
    *)
      echo "install: warning: $gateway_url is plaintext HTTP, so the API key" >&2
      echo 'travels unencrypted. Ask the operator for an https:// URL.' >&2
      ;;
  esac
fi

case $ssh_host in
  ''|*[!A-Za-z0-9._:-]*)
    echo 'install: SSH host may contain only letters, digits, dot, underscore, colon, and hyphen' >&2
    exit 2
    ;;
esac

case $remote_key_path in
  /*) ;;
  *)
    echo 'install: --remote-key-path must be an absolute path' >&2
    exit 2
    ;;
esac
case $remote_key_path in
  *[\'\"\$\`]*|*' '*)
    echo 'install: --remote-key-path may not contain quotes, spaces, $, or backticks' >&2
    exit 2
    ;;
esac

validate_port() {
  port=$1
  label=$2
  case $port in
    ''|*[!0-9]*)
      echo "install: $label must be a numeric TCP port" >&2
      exit 2
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "install: $label must be between 1 and 65535" >&2
    exit 2
  fi
}

validate_port "$port0" port0
validate_port "$port1" port1
if [ "$port0" = "$port1" ]; then
  echo 'install: port0 and port1 must be different' >&2
  exit 2
fi

required_commands='ssh curl sed install opencode'
if [ "$mode" = gateway ]; then
  required_commands='curl sed install opencode'
fi

for command_name in $required_commands; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "install: required command not found: $command_name" >&2
    if [ "$command_name" = opencode ]; then
      echo 'Install OpenCode from https://opencode.ai/docs/ and retry.' >&2
    fi
    exit 1
  fi
done

if [ -n "$ssh_identity" ]; then
  case $ssh_identity in
    '~'/*) ssh_identity="$HOME/${ssh_identity#'~/'}" ;;
  esac
  if [ ! -r "$ssh_identity" ]; then
    echo "install: cannot read the key at $ssh_identity" >&2
    exit 2
  fi
  case $ssh_identity in
    *.pub)
      echo 'install: --ssh-identity wants the private key, not the .pub half.' >&2
      exit 2
      ;;
  esac
fi

TELLICO_REMOTE_KEY_PATH=$remote_key_path
TELLICO_SSH_IDENTITY=$ssh_identity
export TELLICO_REMOTE_KEY_PATH TELLICO_SSH_IDENTITY
. "$script_dir/lib/checks.sh"

if [ "$start_client" = true ] && [ "$mode" = tunnel ]; then
  if tellico_ssh_is_windows; then
    echo "install: ssh resolves to $(command -v ssh)" >&2
    echo 'This WSL session is using Windows ssh.exe, which does not share' >&2
    echo '~/.ssh or the agent with the Linux side, and cannot hold the' >&2
    echo 'tunnel control socket. Install the native client:' >&2
    echo '  sudo apt install openssh-client' >&2
    exit 1
  fi

  echo "Checking access to $ssh_host..."
  echo
  if ! tellico_preflight; then
    echo
    echo 'install: nothing was installed. Resolve the step above and rerun.' >&2
    echo 'Recheck at any time with ./doctor.sh, or install the files now' >&2
    echo 'and connect later with ./install.sh --no-start.' >&2
    exit 1
  fi
  echo
fi

bin_dir="$HOME/.local/bin"
systemd_dir="$config_home/systemd/user"

# Each provider gets one base URL. In tunnel mode those are the forwarded
# loopback ports; in gateway mode they are the gateway's node-pinned paths, so
# the model ids, agents and display names stay identical between modes.
base_url0=$(tellico_base_url "$mode" "$gateway_url" 0 "$port0")
base_url1=$(tellico_base_url "$mode" "$gateway_url" 1 "$port1")
plugin_dir="$config_dir/plugins"

mkdir -p "$config_dir/prompts" "$config_dir/lib" "$plugin_dir/tui" "$plugin_dir/tui-v2/subagents" \
  "$plugin_dir/secret-guard" "$plugin_dir/dispatch-balance" \
  "$plugin_dir/compaction-guard" "$bin_dir"
chmod 700 "$config_dir"

# In gateway mode the key comes from the operator rather than over SSH, so it
# is written here; tunnel mode fetches it in tellico-qwen-tunnel.
if [ "$mode" = gateway ]; then
  umask 077
  key_tmp="$config_dir/.api-key.tmp.$$"
  trap 'rm -f "$key_tmp"' EXIT HUP INT TERM
  if [ -n "$api_key_file" ]; then
    if [ ! -r "$api_key_file" ]; then
      echo "install: cannot read $api_key_file" >&2
      exit 1
    fi
    tr -d '\r\n' <"$api_key_file" >"$key_tmp"
  elif [ ! -t 0 ]; then
    tr -d '\r\n' >"$key_tmp"
  elif [ -s "$config_dir/api-key" ]; then
    # Rerunning after a git pull must not demand the key again. Replace it by
    # passing --api-key-file, or by piping a new one in.
    cat "$config_dir/api-key" >"$key_tmp"
    echo 'Keeping the API key already on this device.'
  else
    printf 'Gateway API key for %s: ' "$gateway_url" >&2
    stty -echo 2>/dev/null || true
    IFS= read -r key_input || key_input=
    stty echo 2>/dev/null || true
    printf '\n' >&2
    printf '%s' "$key_input" >"$key_tmp"
    key_input=
  fi
  if [ ! -s "$key_tmp" ]; then
    echo 'install: no API key was supplied.' >&2
    echo 'Pass one with --api-key-file PATH, pipe it in, or type it when asked.' >&2
    exit 1
  fi
  mv "$key_tmp" "$config_dir/api-key"
  chmod 600 "$config_dir/api-key"
  trap - EXIT HUP INT TERM
  umask 022
fi

config_tmp="$config_dir/.opencode.json.tmp.$$"
trap 'rm -f "$config_tmp"' EXIT HUP INT TERM
tellico_render_config "$script_dir/config/opencode.json" \
  "$base_url0" "$base_url1" "$plugin_dir" >"$config_tmp"
mv "$config_tmp" "$config_dir/opencode.json"
chmod 600 "$config_dir/opencode.json"
trap - EXIT HUP INT TERM
install -m 644 "$script_dir/lib/checks.sh" "$config_dir/lib/checks.sh"
install -m 600 "$script_dir/prompts/orchestrate.md" "$config_dir/prompts/orchestrate.md"
install -m 600 "$script_dir/prompts/worker.md" "$config_dir/prompts/worker.md"
# OpenCode loads these itself, with its own bundled runtime: no npm install
# and no build step. They enforce what the prompts can only ask for. Each is a
# directory with a package.json because OpenCode 2 refuses a bare plugin file;
# OpenCode 1 accepts either.
for plugin in secret-guard dispatch-balance compaction-guard; do
  install -m 644 "$script_dir/plugins/$plugin/index.js" "$plugin_dir/$plugin/index.js"
  install -m 644 "$script_dir/plugins/$plugin/package.json" "$plugin_dir/$plugin/package.json"
done
# Single-file plugins from an older install. Nothing names them any more.
rm -f "$plugin_dir/secret-guard.js" "$plugin_dir/dispatch-balance.js"
# The TUI loads its plugins from tui.json, not opencode.json, and
# opencode-tellico points OPENCODE_TUI_CONFIG at this one.
install -m 644 "$script_dir/plugins/tui/subagent-watch.js" "$plugin_dir/tui/subagent-watch.js"
# OpenCode 2's counterpart, a directory whose tui.js the launcher adds to the
# CLI config's plugin list; see bin/opencode-tellico.
install -m 644 "$script_dir/plugins/tui-v2/subagents/tui.js" "$plugin_dir/tui-v2/subagents/tui.js"
install -m 644 "$script_dir/plugins/tui-v2/subagents/package.json" "$plugin_dir/tui-v2/subagents/package.json"
tellico_render_config "$script_dir/config/tui.json" \
  "$base_url0" "$base_url1" "$plugin_dir" >"$config_dir/tui.json"
install -m 755 "$script_dir/bin/opencode-tellico" "$bin_dir/opencode-tellico"

# Codex support was removed: it exposes no delegation tool, so it could not
# use the two workers this setup exists for. Clean up after an older install.
rm -f "$bin_dir/codex-tellico" \
  "${CODEX_HOME:-$HOME/.codex}/tellico.config.toml"
install -m 755 "$script_dir/bin/tellico-qwen-tunnel" "$bin_dir/tellico-qwen-tunnel"

umask 077
env_tmp="$config_dir/.client.env.tmp.$$"
trap 'rm -f "$env_tmp"' EXIT HUP INT TERM
{
  printf "TELLICO_MODE='%s'\n" "$mode"
  printf "TELLICO_GATEWAY_URL='%s'\n" "$gateway_url"
  printf "TELLICO_SSH_HOST='%s'\n" "$ssh_host"
  printf "TELLICO_QWEN_PORT0='%s'\n" "$port0"
  printf "TELLICO_QWEN_PORT1='%s'\n" "$port1"
  printf "TELLICO_REMOTE_KEY_PATH='%s'\n" "$remote_key_path"
  printf "TELLICO_SSH_IDENTITY='%s'\n" "$ssh_identity"
} >"$env_tmp"
mv "$env_tmp" "$config_dir/client.env"
chmod 600 "$config_dir/client.env"
trap - EXIT HUP INT TERM

if [ "$mode" = tunnel ] &&
  command -v systemctl >/dev/null 2>&1 &&
  systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$systemd_dir"
  unit_tmp="$systemd_dir/.tellico-qwen-tunnel.service.tmp.$$"
  trap 'rm -f "$unit_tmp"' EXIT HUP INT TERM
  if [ -n "$ssh_identity" ]; then
    identity_opts="-o IdentityFile=$ssh_identity -o IdentitiesOnly=yes"
  else
    identity_opts=""
  fi
  sed \
    -e "s|__TELLICO_SSH_IDENTITY_OPTS__|$identity_opts|g" \
    -e "s|__TELLICO_SSH_HOST__|$ssh_host|g" \
    -e "s|__TELLICO_QWEN_PORT0__|$port0|g" \
    -e "s|__TELLICO_QWEN_PORT1__|$port1|g" \
    "$script_dir/systemd/tellico-qwen-tunnel.service.in" >"$unit_tmp"
  mv "$unit_tmp" "$systemd_dir/tellico-qwen-tunnel.service"
  trap - EXIT HUP INT TERM
  systemctl --user daemon-reload
  systemctl --user enable tellico-qwen-tunnel.service >/dev/null
fi

servers_ready=true
if [ "$start_client" = true ]; then
  echo 'Checking the installed OpenCode provider configuration...'
  if ! tellico_check_config "$config_dir/opencode.json"; then
    echo 'install: the installed OpenCode configuration is not usable' >&2
    echo 'Rerun install.sh from a clean checkout of this repository.' >&2
    exit 1
  fi

  # A missing allocation is a cluster state, not an installation failure.
  if [ "$mode" = gateway ]; then
    TELLICO_MODE=$mode
    TELLICO_GATEWAY_URL=$gateway_url
    echo 'Checking the gateway...'
    echo
    tellico_check_gateway "$config_dir/api-key" || servers_ready=false
  else
    "$bin_dir/tellico-qwen-tunnel" restart || servers_ready=false
  fi
fi

echo
echo 'Tellico OpenCode client installed successfully.'

if ! tellico_bin_on_path; then
  profile=$(tellico_shell_profile)
  path_line=$(tellico_path_line)

  if tellico_profile_sets_path "$profile"; then
    echo "Note: $profile already adds $bin_dir to PATH, but this shell"
    echo 'predates it. Open a new terminal to pick the commands up.'
  elif [ "$fix_path" = true ]; then
    mkdir -p "$(dirname "$profile")"
    printf '\n# Added by tellico-agentic-setup\n%s\n' "$path_line" >>"$profile"
    echo "Added $bin_dir to PATH in $profile."
    echo 'Open a new terminal to pick the commands up.'
  else
    echo "Warning: $bin_dir is not on PATH, and $profile does not add it." >&2
    echo 'The installed commands will not be found. Fix it with:' >&2
    echo >&2
    echo '  ./install.sh --fix-path' >&2
    echo >&2
    echo 'or by hand:' >&2
    echo >&2
    echo "  echo '$path_line' >> $profile" >&2
  fi
elif [ "$fix_path" = true ]; then
  echo "$bin_dir is already on PATH; nothing to change."
fi

if [ "$start_client" != true ]; then
  echo
  echo 'Files only: the tunnel was not started and nothing was checked.'
  echo 'When this device can reach Tellico, run: ./doctor.sh'
  exit 0
fi

if [ "$servers_ready" != true ]; then
  if [ "$mode" = gateway ]; then
    echo
    echo 'The client is installed, but the step above has to be resolved'
    echo 'before a session will work.'
    exit 0
  fi
  echo
  echo 'The client is ready, but the model servers are not running yet.'
  echo 'They exist only while a Slurm allocation is active:'
  echo
  echo "  ssh $ssh_host qwen38-submit"
  echo "  ssh $ssh_host 'qwen38-status --wait'"
  echo '  tellico-qwen-tunnel restart'
  exit 0
fi

echo 'Start dual-node orchestration: opencode-tellico 0'
echo 'Alternative lead node:        opencode-tellico 1'
if [ "$mode" = gateway ]; then
  echo 'Check connectivity:           tellico-qwen-tunnel status'
  echo 'Diagnose problems:            ./doctor.sh'
  echo
  echo "This device is in gateway mode against $gateway_url."
  echo 'It uses no SSH and holds no cluster credential beyond your own API key.'
else
  echo 'Check connectivity:           tellico-qwen-tunnel status'
  echo 'Diagnose problems:            tellico-qwen-tunnel doctor'
fi
