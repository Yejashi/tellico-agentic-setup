#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ssh_host=${TELLICO_SSH_HOST:-tellico}
port0=${TELLICO_QWEN_PORT0:-18080}
port1=${TELLICO_QWEN_PORT1:-18081}
remote_key_path=${TELLICO_REMOTE_KEY_PATH:-/home/bbogale/qwen38-cluster/secrets/api-key}
start_client=true
fix_path=false

usage() {
  cat <<'EOF'
usage: ./install.sh [--ssh-host HOST] [--port0 PORT] [--port1 PORT]
                    [--remote-key-path PATH] [--fix-path] [--no-start]

Installs the Tellico OpenCode client for the current user.

  --ssh-host HOST  SSH hostname or config alias (default: tellico)
  --remote-key-path PATH
                   Path to the model API key on the cluster
                   (default: /home/bbogale/qwen38-cluster/secrets/api-key).
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
    --ssh-host)
      [ "$#" -ge 2 ] || { echo 'install: --ssh-host requires a value' >&2; exit 2; }
      ssh_host=$2
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

for command_name in ssh curl sed install opencode; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "install: required command not found: $command_name" >&2
    if [ "$command_name" = opencode ]; then
      echo 'Install OpenCode from https://opencode.ai/docs/ and retry.' >&2
    fi
    exit 1
  fi
done

TELLICO_REMOTE_KEY_PATH=$remote_key_path
export TELLICO_REMOTE_KEY_PATH
. "$script_dir/lib/checks.sh"

if [ "$start_client" = true ]; then
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

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
config_dir="$config_home/tellico-qwen"
bin_dir="$HOME/.local/bin"
systemd_dir="$config_home/systemd/user"

mkdir -p "$config_dir/prompts" "$config_dir/lib" "$bin_dir"
chmod 700 "$config_dir"
install -m 600 "$script_dir/config/opencode.json" "$config_dir/opencode.json"
install -m 644 "$script_dir/lib/checks.sh" "$config_dir/lib/checks.sh"
install -m 600 "$script_dir/prompts/orchestrate.md" "$config_dir/prompts/orchestrate.md"
install -m 600 "$script_dir/prompts/worker.md" "$config_dir/prompts/worker.md"
install -m 755 "$script_dir/bin/opencode-tellico" "$bin_dir/opencode-tellico"
install -m 755 "$script_dir/bin/tellico-qwen-tunnel" "$bin_dir/tellico-qwen-tunnel"

umask 077
env_tmp="$config_dir/.client.env.tmp.$$"
trap 'rm -f "$env_tmp"' EXIT HUP INT TERM
{
  printf "TELLICO_SSH_HOST='%s'\n" "$ssh_host"
  printf "TELLICO_QWEN_PORT0='%s'\n" "$port0"
  printf "TELLICO_QWEN_PORT1='%s'\n" "$port1"
  printf "TELLICO_REMOTE_KEY_PATH='%s'\n" "$remote_key_path"
} >"$env_tmp"
mv "$env_tmp" "$config_dir/client.env"
chmod 600 "$config_dir/client.env"
trap - EXIT HUP INT TERM

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$systemd_dir"
  unit_tmp="$systemd_dir/.tellico-qwen-tunnel.service.tmp.$$"
  trap 'rm -f "$unit_tmp"' EXIT HUP INT TERM
  sed \
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
  echo 'Validating the merged OpenCode provider configuration...'
  OPENCODE_CONFIG="$config_dir/opencode.json" opencode models tellico-0 >/dev/null
  OPENCODE_CONFIG="$config_dir/opencode.json" opencode models tellico-1 >/dev/null

  # A missing allocation is a cluster state, not an installation failure.
  "$bin_dir/tellico-qwen-tunnel" restart || servers_ready=false
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
echo 'Check connectivity:           tellico-qwen-tunnel status'
echo 'Diagnose problems:            tellico-qwen-tunnel doctor'
