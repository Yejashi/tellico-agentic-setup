#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ssh_host=${TELLICO_SSH_HOST:-tellico}
port0=${TELLICO_QWEN_PORT0:-18080}
port1=${TELLICO_QWEN_PORT1:-18081}
start_client=true

usage() {
  cat <<'EOF'
usage: ./install.sh [--ssh-host HOST] [--port0 PORT] [--port1 PORT] [--no-start]

Installs the Tellico OpenCode client for the current user.

  --ssh-host HOST  SSH hostname or config alias (default: tellico)
  --port0 PORT     Local port for tellico-compute0 (default: 18080)
  --port1 PORT     Local port for tellico-compute1 (default: 18081)
  --no-start       Install without starting or validating the tunnel
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

echo "Checking SSH access to $ssh_host..."
if ! ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" \
  'test -r /home/bbogale/qwen38-cluster/secrets/api-key'; then
  echo "install: cannot read the Tellico API key through SSH host '$ssh_host'" >&2
  echo 'Confirm VPN/network access, SSH config, and the device public key.' >&2
  exit 1
fi

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
config_dir="$config_home/tellico-qwen"
bin_dir="$HOME/.local/bin"
systemd_dir="$config_home/systemd/user"

mkdir -p "$config_dir/prompts" "$bin_dir"
chmod 700 "$config_dir"
install -m 600 "$script_dir/config/opencode.json" "$config_dir/opencode.json"
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

case :"${PATH}": in
  *:"$bin_dir":*) ;;
  *)
    echo "Warning: $bin_dir is not currently on PATH." >&2
    echo 'Open a new terminal or add: export PATH="$HOME/.local/bin:$PATH"' >&2
    ;;
esac

if [ "$start_client" = true ]; then
  "$bin_dir/tellico-qwen-tunnel" restart

  echo 'Validating the merged OpenCode provider configuration...'
  OPENCODE_CONFIG="$config_dir/opencode.json" opencode models tellico-0 >/dev/null
  OPENCODE_CONFIG="$config_dir/opencode.json" opencode models tellico-1 >/dev/null
fi

echo
echo 'Tellico OpenCode client installed successfully.'
echo 'Start dual-node orchestration: opencode-tellico 0'
echo 'Alternative lead node:        opencode-tellico 1'
echo 'Check connectivity:           tellico-qwen-tunnel status'
