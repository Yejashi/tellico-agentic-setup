#!/bin/sh
set -eu

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
config_dir="$config_home/tellico-qwen"
gateway_dir="$config_home/tellico-gateway"
bin_dir="$HOME/.local/bin"
lib_dir="$HOME/.local/lib/tellico-gateway"
systemd_dir="$config_home/systemd/user"
unit_name=tellico-qwen-tunnel.service
gateway_unit=tellico-gateway.service

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
  systemctl --user disable --now "$gateway_unit" >/dev/null 2>&1 || true
fi

if [ -x "$bin_dir/tellico-qwen-tunnel" ]; then
  "$bin_dir/tellico-qwen-tunnel" stop >/dev/null 2>&1 || true
fi

rm -f \
  "$bin_dir/opencode-tellico" \
  "$bin_dir/tellico-qwen-tunnel" \
  "$systemd_dir/$unit_name" \
  "$config_dir/api-key" \
  "$config_dir/client.env" \
  "$config_dir/opencode.json" \
  "$config_dir/prompts/orchestrate.md" \
  "$config_dir/prompts/worker.md" \
  "$config_dir/prompts/build.md" \
  "$config_dir/lib/checks.sh" \
  "$config_dir/tui.json" \
  "$config_dir/plugins/secret-guard.js" \
  "$config_dir/plugins/dispatch-balance.js" \
  "$config_dir/plugins/secret-guard/index.js" \
  "$config_dir/plugins/secret-guard/package.json" \
  "$config_dir/plugins/dispatch-balance/index.js" \
  "$config_dir/plugins/dispatch-balance/package.json" \
  "$config_dir/plugins/compaction-guard/index.js" \
  "$config_dir/plugins/compaction-guard/package.json" \
  "$config_dir/plugins/tui/subagent-watch.js" \
  "$config_dir/plugins/tui-v2/subagents/tui.js" \
  "$config_dir/plugins/tui-v2/subagents/package.json" \
  "$bin_dir/tellico-gateway" \
  "$lib_dir/tellico_gateway.py" \
  "$systemd_dir/$gateway_unit" \
  "$gateway_dir/gateway.env"

rm -rf "$lib_dir/__pycache__"
rmdir "$lib_dir" 2>/dev/null || true
rmdir "$config_dir/prompts" 2>/dev/null || true
rmdir "$config_dir/lib" 2>/dev/null || true
rmdir "$config_dir/plugins/tui" 2>/dev/null || true
rmdir "$config_dir/plugins/tui-v2/subagents" 2>/dev/null || true
rmdir "$config_dir/plugins/tui-v2" 2>/dev/null || true
rmdir "$config_dir/plugins/secret-guard" 2>/dev/null || true
rmdir "$config_dir/plugins/dispatch-balance" 2>/dev/null || true
rmdir "$config_dir/plugins/compaction-guard" 2>/dev/null || true
rmdir "$config_dir/plugins" 2>/dev/null || true
rmdir "$config_dir" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
fi

echo 'Tellico OpenCode client removed.'

# The keys file is five people's credentials, not this repository's state, so
# removing it is always a deliberate act.
if [ -s "$gateway_dir/keys" ]; then
  echo
  echo "Kept $gateway_dir/keys, which still holds the gateway's user keys."
  echo 'Delete it yourself if the gateway is gone for good.'
  if command -v tailscale >/dev/null 2>&1 &&
    tailscale funnel status 2>/dev/null | grep -q '^https://'; then
    echo 'A Tailscale Funnel is still published; turn it off with:'
    echo '  tailscale funnel reset'
  fi
fi
