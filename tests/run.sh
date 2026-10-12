#!/bin/sh
set -eu
test_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$test_root"
for script in bin/* install.sh uninstall.sh doctor.sh lib/checks.sh \
  gateway/bin/tellico-gateway gateway/install-gateway.sh crush/hooks/*.sh tests/run.sh; do
  sh -n "$script"
done
python3 -m json.tool config/opencode.json >/dev/null
node --test tests/*.test.mjs
