#!/bin/sh
# Put the Tellico dashboard into Grafana on the gateway host (README.md here).
#
# Assumes Grafana (apt.grafana.com) and the frser-sqlite-datasource plugin are
# installed, and the dashboard keeps its database at /var/lib/tellico-dashboard
# (dashboard/install-dashboard.sh --db ...). Needs sudo. Restarts Grafana only;
# the gateway, tunnel, relay and proxy are untouched.
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

command -v grafana >/dev/null 2>&1 || { echo 'install-grafana.sh: Grafana is not installed.' >&2; exit 1; }
[ -d /var/lib/grafana/plugins/frser-sqlite-datasource ] ||
  sudo grafana cli plugins install frser-sqlite-datasource

python3 "$here/build_dashboard.py" >/dev/null
sudo install -m 0644 "$here/datasource.yaml" /etc/grafana/provisioning/datasources/tellico.yaml
sudo install -m 0644 "$here/dashboards.yaml" /etc/grafana/provisioning/dashboards/tellico.yaml
sudo install -d -o root -g grafana -m 0755 /var/lib/grafana/dashboards/tellico
sudo install -m 0644 "$here/tellico.json" /var/lib/grafana/dashboards/tellico/tellico.json

# Loopback only, served under /grafana/ by Caddy. Written once, between markers.
if ! grep -q '^# >>> tellico' /etc/default/grafana-server 2>/dev/null; then
  sudo sh -c 'cat "$1" >>/etc/default/grafana-server' sh "$here/grafana.env"
fi

sudo systemctl enable grafana-server >/dev/null 2>&1
sudo systemctl restart grafana-server
i=0
until curl -fsS -m 3 http://127.0.0.1:3000/grafana/api/health >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo 'install-grafana.sh: Grafana did not come up; journalctl -u grafana-server' >&2; exit 1; }
  sleep 1
done
echo 'Grafana is up on 127.0.0.1:3000/grafana/ with the Tellico dashboard.'
