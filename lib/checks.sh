# Shared Tellico client checks.
#
# Sourced by install.sh, doctor.sh, and tellico-qwen-tunnel. The caller sets
# ssh_host before calling anything here. Every other value has a default that
# an environment variable can override.

# The key lives in the lab's shared space rather than the service owner's
# home directory, which is not traversable by other accounts.
: "${TELLICO_REMOTE_KEY_PATH:=/data/gclab/qwen38/secrets/api-key}"
: "${TELLICO_CONNECT_TIMEOUT:=15}"

# An explicit private key, for when ssh_config names one ssh cannot use and is
# itself not editable -- a home-manager or otherwise managed ~/.ssh/config.
: "${TELLICO_SSH_IDENTITY:=}"
tellico_identity_opts() {
  if [ -n "$TELLICO_SSH_IDENTITY" ]; then
    printf '%s' "-o IdentityFile=$TELLICO_SSH_IDENTITY -o IdentitiesOnly=yes"
  fi
}

# Who owns the Slurm allocation, and what the service job is called. Used to
# read the queue, which any account on the cluster may do.
: "${TELLICO_SERVICE_USER:=bbogale}"
: "${TELLICO_JOB_NAME:=qwen38-api}"

# Where the model servers answer, from the cluster's own network.
: "${TELLICO_COMPUTE_NODES:=tellico-compute0 tellico-compute1}"
: "${TELLICO_MODEL_PORT:=8000}"

tellico_status_line() {
  printf '  %-12s %-5s %s\n' "$1" "$2" "$3"
}

# user@hostname:port that "$ssh_host" actually resolves to, or empty.
tellico_ssh_target() {
  ssh -G "$ssh_host" 2>/dev/null | awk '
    $1 == "user" && u == "" { u = $2 }
    $1 == "hostname" && h == "" { h = $2 }
    $1 == "port" && p == "" { p = $2 }
    END { if (h != "") printf "%s@%s:%s\n", u, h, p }
  '
}

# Account "$ssh_host" logs in as, or empty.
tellico_ssh_account() {
  tellico_ssh_target | sed 's/@.*//'
}

# Private key this device would offer for "$ssh_host", or empty when it has
# none. ssh -G lists every candidate IdentityFile, including built-in defaults
# that need not exist. An entry may name either half of the pair -- ssh_config
# documents pointing IdentityFile at a public key, and real configs do -- so
# strip .pub before deciding which files are actually there.
tellico_device_key() {
  ssh -G "$ssh_host" 2>/dev/null | awk '$1 == "identityfile" { print $2 }' |
    while IFS= read -r tellico_identity; do
      case $tellico_identity in
        '~'/*) tellico_identity="$HOME/${tellico_identity#'~/'}" ;;
      esac
      tellico_identity=${tellico_identity%.pub}
      if [ -r "$tellico_identity" ] || [ -r "$tellico_identity.pub" ]; then
        printf '%s\n' "$tellico_identity"
        break
      fi
    done
}

# Path of the public key this device would offer, or empty when the device has
# no key at all or has only the private half.
tellico_device_pubkey() {
  tellico_found_key=$(tellico_device_key)
  [ -n "$tellico_found_key" ] || return 1
  [ -r "$tellico_found_key.pub" ] || return 1
  printf '%s\n' "$tellico_found_key.pub"
}

# The first IdentityFile for "$ssh_host" whose path ends in .pub, or empty.
# ssh reads any IdentityFile as a private key and holds it to private-key
# permissions, so naming the public half means no key is offered at all.
tellico_pub_identityfile() {
  ssh -G "$ssh_host" 2>/dev/null |
    awk '$1 == "identityfile" && $2 ~ /\.pub$/ { print $2; exit }'
}

# Where a key for "$ssh_host" belongs: the first IdentityFile the config names
# for it, or the usual default when it names none. Used to tell a device with
# no key where to put one, so ssh-keygen and the config agree.
tellico_intended_key() {
  tellico_intended=$(ssh -G "$ssh_host" 2>/dev/null |
    awk '$1 == "identityfile" { print $2; exit }')
  case $tellico_intended in
    '') tellico_intended="$HOME/.ssh/id_ed25519" ;;
    '~'/*) tellico_intended="$HOME/${tellico_intended#'~/'}" ;;
  esac
  printf '%s\n' "${tellico_intended%.pub}"
}

# Classifies one non-interactive SSH attempt. Sets tellico_probe_result to
# ok, dns, unreachable, hostkey, denied, or unknown.
#
# ControlPath=none is what makes the verdict mean anything. Plenty of people
# carry "ControlMaster auto" in a Host * block, and a request that rides an
# existing master never authenticates at all, so an unauthorized device gets
# reported as authorized for as long as ControlPersist keeps that socket warm.
# The tunnel opens a master of its own and does have to authenticate, so this
# probe has to as well.
tellico_probe_ssh() {
  # shellcheck disable=SC2046
  if tellico_probe_output=$(ssh -o BatchMode=yes -o ControlPath=none \
    $(tellico_identity_opts) \
    -o ConnectTimeout="$TELLICO_CONNECT_TIMEOUT" "$ssh_host" true 2>&1); then
    tellico_probe_result=ok
    return 0
  fi

  case $tellico_probe_output in
    *'Could not resolve hostname'*|*'Name or service not known'*|\
    *'nodename nor servname'*)
      tellico_probe_result=dns
      ;;
    *'Connection timed out'*|*'Operation timed out'*|*'No route to host'*|\
    *'Network is unreachable'*|*'Connection refused'*|*'Connection closed'*)
      tellico_probe_result=unreachable
      ;;
    *'Host key verification failed'*|*'HOST IDENTIFICATION HAS CHANGED'*)
      tellico_probe_result=hostkey
      ;;
    *'Permission denied'*)
      tellico_probe_result=denied
      ;;
    *)
      tellico_probe_result=unknown
      ;;
  esac
  return 1
}

tellico_explain_dns() {
  cat <<EOF

Next step: '$ssh_host' does not resolve.

  Add an alias to ~/.ssh/config, naming your own cluster account and the
  key this device should offer:

    Host $ssh_host
      HostName tellico.icl.utk.edu
      User YOUR_CLUSTER_ACCOUNT
      IdentityFile ~/.ssh/id_ed25519

  $TELLICO_SERVICE_USER owns the allocation but is not a shared login. Use
  it as User only if it is your account.

  If the alias is already there, the name is resolved by the site DNS, so
  connect to the VPN first.
EOF
}

tellico_explain_unreachable() {
  cat <<EOF

Next step: the host resolves but does not accept connections.

  This is almost always the VPN. Connect to it and try again.
  Raise TELLICO_CONNECT_TIMEOUT if the link is just slow.
EOF
}

tellico_explain_hostkey() {
  cat <<EOF

Next step: the host key does not match ~/.ssh/known_hosts.

  Verify the change is expected before removing the stored key:

    ssh-keygen -R $(tellico_ssh_target | sed 's/.*@//; s/:.*//')
EOF
}

# True when the private key is encrypted and no agent is holding it, which
# BatchMode reports as a plain "Permission denied". Takes either half of the
# pair.
tellico_key_locked() {
  tellico_privkey=${1%.pub}
  [ -r "$tellico_privkey" ] || return 1
  if ssh-keygen -y -P '' -f "$tellico_privkey" >/dev/null 2>&1; then
    return 1
  fi
  if [ -r "$tellico_privkey.pub" ]; then
    tellico_fingerprint=$(ssh-keygen -lf "$tellico_privkey.pub" 2>/dev/null |
      awk '{print $2}')
  else
    tellico_fingerprint=$(ssh-keygen -lf "$tellico_privkey" 2>/dev/null |
      awk '{print $2}')
  fi
  [ -n "$tellico_fingerprint" ] || return 0
  if ssh-add -l 2>/dev/null | grep -qF "$tellico_fingerprint"; then
    return 1
  fi
  return 0
}

# True when ssh comes from Windows via WSL interop rather than from the
# distribution, which makes ~/.ssh and agent handling behave unexpectedly.
tellico_ssh_is_windows() {
  case $(command -v ssh 2>/dev/null) in
    /mnt/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Why "Permission denied" happened: nokey, nopub, locked, or unauthorized.
# The status line and the explanation both read this, so the two agree.
tellico_denied_reason() {
  # ssh refusing to load a key is reported by the server as the same
  # "Permission denied" an unauthorized key gets, so read ssh's own
  # complaint before blaming the far end. Checked first: a key that cannot
  # be loaded is never offered, whatever else is true of it.
  case ${tellico_probe_output:-} in
    *'bad permissions'*|*'are too open'*|*'This private key will be ignored'*|\
    *'invalid format'*)
      printf 'keyperms\n'
      return 0
      ;;
  esac

  tellico_reason_key=$(tellico_device_key)
  if [ -z "$tellico_reason_key" ]; then
    printf 'nokey\n'
  elif [ ! -r "$tellico_reason_key.pub" ]; then
    printf 'nopub\n'
  elif tellico_key_locked "$tellico_reason_key"; then
    printf 'locked\n'
  else
    printf 'unauthorized\n'
  fi
}

# Added when the account being used is the one that owns the allocation, which
# is one person's account and not a shared login. Authorizing a device there
# is the service owner's own case, so this is a note rather than a failure.
tellico_note_service_account() {
  [ "$(tellico_ssh_account)" = "$TELLICO_SERVICE_USER" ] || return 0
  cat <<EOF

  Note: you are connecting as $TELLICO_SERVICE_USER, the account that owns the
  allocation. That is not a shared login. Unless it is your account, set
  User to your own in the 'Host $ssh_host' block of ~/.ssh/config and
  authorize this device there instead.
EOF
}

tellico_explain_denied() {
  tellico_account=$(tellico_ssh_account)
  tellico_key=$(tellico_device_key)

  case $(tellico_denied_reason) in
    keyperms)
      cat <<EOF

Next step: ssh refused to load the key this device offers, so it offered no
key at all. The server reports that as the same "Permission denied" an
unauthorized key gets, so this is not about $tellico_account's
authorized_keys. ssh said:

EOF
      printf '%s\n' "${tellico_probe_output:-}" |
        grep -E 'Load key|too open|will be ignored|invalid format' |
        sed 's/^/    /'
      tellico_keyperms_pub=$(tellico_pub_identityfile)
      if [ -n "$tellico_keyperms_pub" ]; then
        cat <<EOF

  IdentityFile names $tellico_keyperms_pub, the public half. ssh reads an
  IdentityFile as a private key and requires private-key permissions, which
  a public key correctly does not have. Point it at the private key in the
  'Host $ssh_host' block of ~/.ssh/config:

    IdentityFile ${tellico_keyperms_pub%.pub}

  The public-key spelling only works when an agent is holding the private
  key, which is not the case here.
EOF
      else
        cat <<EOF

  A private key must not be readable by anyone else:

    chmod 600 ${tellico_key:-~/.ssh/id_ed25519}
EOF
      fi
      cat <<EOF

  Then rerun: ./doctor.sh
EOF
      ;;
    nokey)
      cat <<EOF

Next step: this device has no SSH key yet. Create one, then authorize it for
the $tellico_account account on Tellico.

    ssh-keygen -t ed25519 -f $(tellico_intended_key) -C "$(id -un)@$(uname -n)"
    ./doctor.sh

  That second run prints the new public key and the commands that authorize
  it. Never copy a private key from another device; each one gets its own.
EOF
      tellico_note_service_account
      ;;
    nopub)
      cat <<EOF

Next step: this device has a private key but not its public half, so there is
nothing to print or authorize yet. Recreate it from the private key:

    ssh-keygen -y -f $tellico_key >$tellico_key.pub
    ./doctor.sh

  ssh-keygen asks for the passphrase if the key has one.
EOF
      ;;
    locked)
      cat <<EOF

Next step: this device's key is encrypted and no SSH agent is holding it,
so the non-interactive check cannot use it. The key may well already be
authorized on Tellico.

    ssh-add $tellico_key

  On macOS, store the passphrase in the keychain so this persists:

    ssh-add --apple-use-keychain $tellico_key

  Then rerun: ./doctor.sh
EOF
      ;;
    *)
      cat <<EOF

Next step: this device's SSH key is not authorized for $tellico_account on
Tellico. It has to be in that account's ~/.ssh/authorized_keys.

  Public key ($tellico_key.pub):

EOF
      sed 's/^/    /' "$tellico_key.pub"
      cat <<EOF

  From this machine, if the account still accepts passwords:

    ssh-copy-id -o ControlPath=none -i $tellico_key.pub $ssh_host

  Or, from a machine that already works:

    ssh $ssh_host 'umask 077; mkdir -p ~/.ssh; echo "$(cat "$tellico_key.pub")" >> ~/.ssh/authorized_keys'

  Then rerun: ./install.sh
EOF
      tellico_note_service_account
      ;;
  esac
}

tellico_explain_unknown() {
  cat <<EOF

Next step: SSH failed for an unrecognized reason. Raw output:

$(printf '%s\n' "$tellico_probe_output" | sed 's/^/    /')
EOF
}

tellico_explain_key() {
  cat <<EOF

Next step: SSH works, but the account you connect as
($(tellico_ssh_account)) cannot read the model API key:

    $TELLICO_REMOTE_KEY_PATH

  That path is the lab's shared copy. If your account cannot read it, ask
  $TELLICO_SERVICE_USER to add you, or point the installer at a copy you can
  read:

    ./install.sh --remote-key-path /path/to/api-key
EOF
}

# Probes in dependency order and prints one actionable next step.
# Returns 0 when the client can reach the key, 1 otherwise.
tellico_preflight() {
  tellico_target=$(tellico_ssh_target)
  case $tellico_target in
    '')
      tellico_status_line 'ssh config' WARN "no target configured for '$ssh_host'"
      ;;
    *"@$ssh_host:"*)
      # ssh echoes the alias back as the hostname when no Host block matched,
      # so this is a bare name unless it is already an address or FQDN.
      case $ssh_host in
        *.*|*:*) tellico_status_line 'ssh config' OK "$tellico_target" ;;
        *) tellico_status_line 'ssh config' WARN "no Host block for '$ssh_host'" ;;
      esac
      ;;
    *)
      tellico_status_line 'ssh config' OK "$tellico_target"
      ;;
  esac

  if tellico_probe_ssh; then
    tellico_status_line network OK 'host reachable'
    tellico_status_line 'ssh auth' OK 'this device is authorized'
  else
    case $tellico_probe_result in
      dns)
        tellico_status_line network FAIL "cannot resolve '$ssh_host'"
        tellico_explain_dns
        ;;
      unreachable)
        tellico_status_line network FAIL 'host unreachable (VPN?)'
        tellico_explain_unreachable
        ;;
      hostkey)
        tellico_status_line network OK 'host reachable'
        tellico_status_line 'ssh auth' FAIL 'host key mismatch'
        tellico_explain_hostkey
        ;;
      denied)
        tellico_status_line network OK 'host reachable'
        case $(tellico_denied_reason) in
          keyperms)
            tellico_status_line 'ssh auth' FAIL 'ssh could not load this device'"'"'s key'
            ;;
          nokey)
            tellico_status_line 'ssh auth' FAIL 'this device has no SSH key'
            ;;
          nopub)
            tellico_status_line 'ssh auth' FAIL 'private key has no public half'
            ;;
          locked)
            tellico_status_line 'ssh auth' FAIL 'key is encrypted and not in an agent'
            ;;
          *)
            tellico_status_line 'ssh auth' FAIL \
              "key not authorized for $(tellico_ssh_account)"
            ;;
        esac
        tellico_explain_denied
        ;;
      *)
        tellico_status_line network '?' 'ssh failed'
        tellico_explain_unknown
        ;;
    esac
    return 1
  fi

  # shellcheck disable=SC2046
  if ssh -o BatchMode=yes -o ConnectTimeout="$TELLICO_CONNECT_TIMEOUT" \
    $(tellico_identity_opts) \
    "$ssh_host" "test -r '$TELLICO_REMOTE_KEY_PATH'" 2>/dev/null; then
    tellico_status_line 'api key' OK 'readable on the cluster'
  else
    tellico_status_line 'api key' FAIL 'not readable on the cluster'
    tellico_explain_key
    return 1
  fi

  return 0
}

# Reports whether the two model servers currently have an allocation.
# Returns 0 when they are up, 1 otherwise.
tellico_check_allocation() {
  # squeue and an authenticated /v1/models probe are both available to any
  # account on the cluster, unlike the service owner's qwen38-* helpers, which
  # live in a home directory no other user can traverse.
  tellico_alloc=$(ssh -o BatchMode=yes \
    -o ConnectTimeout="$TELLICO_CONNECT_TIMEOUT" "$ssh_host" "
      printf 'user %s\n' \"\$(id -un)\"
      printf 'state %s\n' \"\$(squeue -h -u '$TELLICO_SERVICE_USER' \
        -n '$TELLICO_JOB_NAME' -o '%T' 2>/dev/null | head -n 1)\"
      for tellico_node in $TELLICO_COMPUTE_NODES; do
        if curl -fsS --max-time 5 \
          -H \"Authorization: Bearer \$(cat '$TELLICO_REMOTE_KEY_PATH')\" \
          \"http://\$tellico_node:$TELLICO_MODEL_PORT/v1/models\" >/dev/null 2>&1
        then
          printf 'ready %s\n' \"\$tellico_node\"
        fi
      done
    " 2>/dev/null)

  tellico_alloc_user=$(printf '%s\n' "$tellico_alloc" | awk '$1 == "user" { print $2 }')
  tellico_alloc_state=$(printf '%s\n' "$tellico_alloc" | awk '$1 == "state" { print $2 }')
  tellico_alloc_ready=$(printf '%s\n' "$tellico_alloc" | grep -c '^ready ' || true)
  # Counted with tr rather than word-splitting an unquoted expansion, which
  # zsh does not do -- this file is sourced by interactive shells too.
  tellico_alloc_total=$(printf '%s' "$TELLICO_COMPUTE_NODES" |
    tr -s ' ' '\n' | grep -c .)

  if [ "$tellico_alloc_ready" -eq "$tellico_alloc_total" ]; then
    tellico_status_line allocation OK 'model servers running'
    return 0
  fi

  if [ "$tellico_alloc_ready" -gt 0 ]; then
    tellico_status_line allocation WARN \
      "only $tellico_alloc_ready of $tellico_alloc_total servers answering"
  else
    case $tellico_alloc_state in
      RUNNING) tellico_status_line allocation WARN 'job running, servers still loading' ;;
      PENDING) tellico_status_line allocation FAIL 'job queued, waiting for nodes' ;;
      '') tellico_status_line allocation FAIL 'no allocation for the service job' ;;
      *) tellico_status_line allocation FAIL "job state $tellico_alloc_state" ;;
    esac
  fi

  echo
  case $tellico_alloc_state in
    RUNNING|PENDING)
      echo 'Next step: the allocation exists but the servers are not ready yet.'
      echo 'A cold start loads the model onto both GPUs and takes a few minutes.'
      echo 'Recheck with ./doctor.sh, then: tellico-qwen-tunnel restart'
      ;;
    *)
      echo 'Next step: the model servers only exist while a Slurm allocation is'
      echo 'active, and there is none right now.'
      echo
      if [ "$tellico_alloc_user" = "$TELLICO_SERVICE_USER" ]; then
        echo "    ssh $ssh_host qwen38-submit"
        echo "    ssh $ssh_host 'qwen38-status --wait'"
        echo '    tellico-qwen-tunnel restart'
      else
        echo "Ask $TELLICO_SERVICE_USER to start it; only that account can submit"
        echo 'the job. Then: tellico-qwen-tunnel restart'
      fi
      ;;
  esac
  echo
  return 1
}

# Profile file the user's login shell reads for interactive sessions.
tellico_shell_profile() {
  case ${SHELL##*/} in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      # macOS terminals start login shells, which skip .bashrc.
      if [ "$(uname -s)" = Darwin ]; then
        printf '%s\n' "$HOME/.bash_profile"
      else
        printf '%s\n' "$HOME/.bashrc"
      fi
      ;;
    fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
    ksh) printf '%s\n' "$HOME/.kshrc" ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}

# The line that puts ~/.local/bin on PATH, in that shell's own syntax.
tellico_path_line() {
  case ${SHELL##*/} in
    fish) printf '%s\n' 'fish_add_path "$HOME/.local/bin"' ;;
    *) printf '%s\n' 'export PATH="$HOME/.local/bin:$PATH"' ;;
  esac
}

tellico_profile_sets_path() {
  [ -r "$1" ] || return 1
  # Only an uncommented line counts; many profiles ship this commented out.
  grep -q '^[^#]*\.local/bin' "$1"
}

tellico_bin_on_path() {
  case :"${PATH}": in
    *:"$HOME/.local/bin":*) return 0 ;;
    *) return 1 ;;
  esac
}

# OpenCode v2 runs plain invocations through a shared background service that
# was started without this client's OPENCODE_CONFIG, so the variable is
# ignored and the node providers come back as "Model unavailable".
# --standalone gives the session its own server, which does read the config.
# OpenCode versions without that background service have no such flag, so
# probe for it rather than assuming either shape.
# TELLICO_OPENCODE_STANDALONE=0 or 1 overrides the probe.
tellico_opencode_standalone_flag() {
  case ${TELLICO_OPENCODE_STANDALONE:-auto} in
    1|true|yes|on)
      echo '--standalone'
      return 0
      ;;
    0|false|no|off)
      return 0
      ;;
  esac

  if opencode --help 2>&1 | grep -q -- '--standalone'; then
    echo '--standalone'
  fi
}

# True when the installed provider configuration declares the providers and
# model that opencode-tellico will ask for.
#
# OpenCode offers no version-stable way to validate a config file:
# "opencode models" takes no provider argument, reports the background
# service's providers rather than OPENCODE_CONFIG's, and lists nothing at all
# under --standalone. So inspect the file directly, using a JSON parser only
# when the system happens to have one.
tellico_check_config() {
  tellico_config=$1
  tellico_config_ok=true

  if [ ! -s "$tellico_config" ]; then
    echo "missing or empty: $tellico_config" >&2
    return 1
  fi

  for tellico_node in 0 1; do
    if ! grep -q "\"tellico-$tellico_node\"" "$tellico_config"; then
      echo "provider tellico-$tellico_node is missing from $tellico_config" >&2
      tellico_config_ok=false
    fi
  done

  if ! grep -q '"qwen3\.8-27b"' "$tellico_config"; then
    echo "model qwen3.8-27b is missing from $tellico_config" >&2
    tellico_config_ok=false
  fi

  if command -v python3 >/dev/null 2>&1; then
    if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' \
      "$tellico_config" >/dev/null 2>&1; then
      echo "not valid JSON: $tellico_config" >&2
      tellico_config_ok=false
    fi
  fi

  # A plugin the config names but the install did not copy across is silently
  # skipped by OpenCode, which would leave the credential guard off without
  # saying so. Half an install is worth reporting as a broken one.
  while IFS= read -r tellico_config_plugin; do
    [ -n "$tellico_config_plugin" ] || continue
    if [ ! -r "$tellico_config_plugin" ]; then
      echo "plugin named by $tellico_config but not installed:" \
        "$tellico_config_plugin" >&2
      tellico_config_ok=false
    fi
  done <<EOF
$(sed -n 's|.*"\(/[^"]*/plugins/[^"]*\.js\)".*|\1|p' "$tellico_config")
EOF

  [ "$tellico_config_ok" = true ]
}

# --- Rendering and drift ----------------------------------------------------
#
# config/opencode.json is a template: install.sh fills in the endpoints and
# the plugin directory of this particular device. Everything in these two
# functions exists so that only one place knows which placeholders there are.

# One provider's base URL. Tunnel mode forwards the private cluster endpoints
# to loopback; gateway mode points at the gateway's node-pinned path.
tellico_base_url() {
  tellico_url_mode=$1
  tellico_url_gateway=$2
  tellico_url_node=$3
  tellico_url_port=$4

  if [ "$tellico_url_mode" = gateway ]; then
    printf '%s/node%s\n' "${tellico_url_gateway%/}" "$tellico_url_node"
  else
    printf 'http://127.0.0.1:%s/v1\n' "$tellico_url_port"
  fi
}

# The template with every placeholder filled in, on stdout.
tellico_render_config() {
  sed \
    -e "s|__TELLICO_BASE_URL_0__|$2|g" \
    -e "s|__TELLICO_BASE_URL_1__|$3|g" \
    -e "s|__TELLICO_PLUGIN_DIR__|$4|g" \
    "$1"
}

# The template parts of a config, with this device's substitutions put back.
# Comparing fingerprints asks "is the installed config still the repository's
# config", independently of which mode or ports the device was installed for.
# Whether those endpoints are the right ones is tellico_check_config's job and
# the gateway probe's, not this one's.
tellico_config_fingerprint() {
  sed \
    -e 's|"baseURL": "[^"]*"|"baseURL": "__TELLICO_BASE_URL__"|' \
    -e 's|"[^"]*/plugins/|"__TELLICO_PLUGIN_DIR__/|' \
    "$1"
}

# Files installed byte for byte, at the same relative path on both sides.
TELLICO_INSTALLED_COPIES='lib/checks.sh
prompts/orchestrate.md
prompts/worker.md
plugins/secret-guard.js
plugins/dispatch-balance.js
plugins/tui/subagent-watch.js'

# Commands installed into the PATH directory rather than the config directory.
TELLICO_INSTALLED_COMMANDS='opencode-tellico
tellico-qwen-tunnel'

# Which installed copies no longer match this checkout. Editing the repository
# changes nothing until install.sh copies the files across, and OpenCode then
# has to be restarted, so a stale copy looks exactly like a change that did
# not work -- the session runs happily on the old prompt. Names the drifted
# files in $tellico_drifted and the absent ones in $tellico_drift_absent;
# returns non-zero when there is anything to report.
tellico_check_drift() {
  tellico_drift_repo=$1
  tellico_drift_config=$2
  tellico_drift_bin=$3
  tellico_drifted=
  tellico_drift_absent=

  while IFS= read -r tellico_drift_name; do
    [ -n "$tellico_drift_name" ] || continue
    tellico_drift_live="$tellico_drift_config/$tellico_drift_name"
    if [ ! -r "$tellico_drift_live" ]; then
      tellico_drift_absent="$tellico_drift_absent $tellico_drift_name"
    elif ! cmp -s "$tellico_drift_repo/$tellico_drift_name" "$tellico_drift_live"; then
      tellico_drifted="$tellico_drifted $tellico_drift_name"
    fi
  done <<EOF
$TELLICO_INSTALLED_COPIES
EOF

  while IFS= read -r tellico_drift_name; do
    [ -n "$tellico_drift_name" ] || continue
    tellico_drift_live="$tellico_drift_bin/$tellico_drift_name"
    if [ ! -r "$tellico_drift_live" ]; then
      tellico_drift_absent="$tellico_drift_absent $tellico_drift_name"
    elif ! cmp -s "$tellico_drift_repo/bin/$tellico_drift_name" "$tellico_drift_live"; then
      tellico_drifted="$tellico_drifted $tellico_drift_name"
    fi
  done <<EOF
$TELLICO_INSTALLED_COMMANDS
EOF

  if [ ! -r "$tellico_drift_config/opencode.json" ]; then
    tellico_drift_absent="$tellico_drift_absent opencode.json"
  else
    tellico_drift_tmp="${TMPDIR:-/tmp}/tellico-drift.$$"
    tellico_config_fingerprint "$tellico_drift_config/opencode.json" \
      >"$tellico_drift_tmp"
    if ! tellico_config_fingerprint "$tellico_drift_repo/config/opencode.json" |
      cmp -s - "$tellico_drift_tmp"; then
      tellico_drifted="$tellico_drifted opencode.json"
    fi
    rm -f "$tellico_drift_tmp"
  fi

  if [ ! -r "$tellico_drift_config/tui.json" ]; then
    tellico_drift_absent="$tellico_drift_absent tui.json"
  else
    tellico_drift_tmp="${TMPDIR:-/tmp}/tellico-drift.$$"
    tellico_config_fingerprint "$tellico_drift_config/tui.json" \
      >"$tellico_drift_tmp"
    if ! tellico_config_fingerprint "$tellico_drift_repo/config/tui.json" |
      cmp -s - "$tellico_drift_tmp"; then
      tellico_drifted="$tellico_drifted tui.json"
    fi
    rm -f "$tellico_drift_tmp"
  fi

  [ -z "$tellico_drifted" ] && [ -z "$tellico_drift_absent" ]
}

# --- Gateway mode -----------------------------------------------------------
#
# A device reaches the models one of two ways, recorded as TELLICO_MODE in
# client.env: "tunnel" forwards the private cluster endpoints over SSH, and
# "gateway" talks to the API gateway with a per-user key and needs no cluster
# account at all. Everything above this line is for tunnel mode.

tellico_is_gateway() {
  [ "${TELLICO_MODE:-tunnel}" = gateway ]
}

# Base URL with any trailing slash removed, so joining a path is predictable.
tellico_gateway_url() {
  tellico_url=${TELLICO_GATEWAY_URL:-}
  printf '%s\n' "${tellico_url%/}"
}

# One authenticated probe of the gateway. Sets tellico_gateway_result to ok,
# unconfigured, nokey, unreachable, unauthorized, no_allocation, or unknown.
tellico_gateway_probe() {
  tellico_gateway_key_file=$1
  tellico_gateway_base=$(tellico_gateway_url)

  if [ -z "$tellico_gateway_base" ]; then
    tellico_gateway_result=unconfigured
    return 1
  fi
  if [ ! -s "$tellico_gateway_key_file" ]; then
    tellico_gateway_result=nokey
    return 1
  fi

  tellico_gateway_code=$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time "$TELLICO_CONNECT_TIMEOUT" \
    -H "Authorization: Bearer $(cat "$tellico_gateway_key_file")" \
    "$tellico_gateway_base/models" 2>/dev/null) || tellico_gateway_code=000

  case $tellico_gateway_code in
    200)
      tellico_gateway_result=ok
      return 0
      ;;
    000) tellico_gateway_result=unreachable ;;
    401|403) tellico_gateway_result=unauthorized ;;
    502|503) tellico_gateway_result=no_allocation ;;
    *) tellico_gateway_result=unknown ;;
  esac
  return 1
}

# Prints the one next step for whatever tellico_gateway_probe found.
tellico_explain_gateway() {
  tellico_gateway_key_file=$1
  tellico_gateway_base=$(tellico_gateway_url)

  case ${tellico_gateway_result:-unknown} in
    unconfigured)
      cat <<EOF

Next step: this device has no gateway URL recorded. Install gateway mode with
the URL and key the service operator gave you:

    ./install.sh --gateway-url https://HOST/v1

EOF
      ;;
    nokey)
      cat <<EOF

Next step: there is no API key at $tellico_gateway_key_file.
Ask the operator for one, then:

    ./install.sh --gateway-url $tellico_gateway_base

EOF
      ;;
    unreachable)
      cat <<EOF

Next step: nothing answered at $tellico_gateway_base.
The gateway is a host the operator runs, so this is usually on their side.
Check it yourself, since /health needs no key:

    curl ${tellico_gateway_base%/v1}/health

If that fails too, tell the operator the gateway is down. If it succeeds, the
recorded URL is wrong; reinstall with the correct one.

EOF
      ;;
    unauthorized)
      cat <<EOF

Next step: $tellico_gateway_base rejected this device's API key.
Keys can be revoked individually, so ask the operator for a new one and
reinstall:

    ./install.sh --gateway-url $tellico_gateway_base

EOF
      ;;
    no_allocation)
      cat <<EOF

Next step: the gateway is up but has no model server behind it. The cluster's
Slurm allocation has ended; only the service owner can submit another. Tell
them, then retry. Nothing on this device needs changing.

EOF
      ;;
    *)
      cat <<EOF

Next step: $tellico_gateway_base answered
HTTP ${tellico_gateway_code:-?}, which this check does not recognise. Send that
to the operator along with:

    curl -i -H "Authorization: Bearer \$(cat $tellico_gateway_key_file)" \\
      $tellico_gateway_base/models

EOF
      ;;
  esac
}

# Status line plus explanation. Returns non-zero when the gateway is not usable.
tellico_check_gateway() {
  tellico_gateway_key_file=$1
  tellico_gateway_base=$(tellico_gateway_url)

  if tellico_gateway_probe "$tellico_gateway_key_file"; then
    tellico_status_line gateway OK "$tellico_gateway_base"
    return 0
  fi

  case $tellico_gateway_result in
    unconfigured) tellico_status_line gateway FAIL 'no gateway URL recorded' ;;
    nokey) tellico_status_line gateway FAIL 'no API key on this device' ;;
    unreachable) tellico_status_line gateway FAIL "no answer from $tellico_gateway_base" ;;
    unauthorized) tellico_status_line gateway FAIL 'API key rejected' ;;
    no_allocation) tellico_status_line gateway WARN 'gateway up, no model server behind it' ;;
    *) tellico_status_line gateway FAIL "HTTP ${tellico_gateway_code:-?}" ;;
  esac
  tellico_explain_gateway "$tellico_gateway_key_file"
  return 1
}
