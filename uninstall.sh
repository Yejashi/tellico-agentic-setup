#!/bin/sh
set -eu

config_home=${XDG_CONFIG_HOME:-"$HOME/.config"}
config_dir="$config_home/tellico-qwen"
bin_dir="$HOME/.local/bin"
systemd_dir="$config_home/systemd/user"
unit_name=tellico-qwen-tunnel.service

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user disable --now "$unit_name" >/dev/null 2>&1 || true
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
  "$config_dir/lib/checks.sh"

rmdir "$config_dir/prompts" 2>/dev/null || true
rmdir "$config_dir/lib" 2>/dev/null || true
rmdir "$config_dir" 2>/dev/null || true

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  systemctl --user daemon-reload
fi

echo 'Tellico OpenCode client removed.'
