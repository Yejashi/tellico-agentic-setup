#!/bin/sh
set -eu
test_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$test_root"
for script in bin/* install.sh uninstall.sh doctor.sh lib/checks.sh \
  gateway/bin/tellico-gateway gateway/install-gateway.sh \
  remote/bin/tellico-remote remote/install-remote.sh \
  relay/bin/tellico-relay relay/install-relay.sh crush/hooks/*.sh tests/run.sh; do
  sh -n "$script"
done
python3 -m json.tool config/opencode.json >/dev/null
python3 -m py_compile relay/tellico_relay.py
node --test tests/*.test.mjs
python3 -I -m unittest discover -s tests -p '*_test.py'
