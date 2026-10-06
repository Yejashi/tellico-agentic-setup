# Shared Tellico client checks.
#
# Sourced by install.sh, doctor.sh, and tellico-qwen-tunnel. The caller sets
# ssh_host before calling anything here. Every other value has a default that
# an environment variable can override.

: "${TELLICO_REMOTE_KEY_PATH:=/home/bbogale/qwen38-cluster/secrets/api-key}"
: "${TELLICO_CONNECT_TIMEOUT:=15}"

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

# Path of the public key this device would offer, or empty when it has none.
tellico_device_pubkey() {
  ssh -G "$ssh_host" 2>/dev/null | awk '$1 == "identityfile" { print $2 }' |
    while IFS= read -r tellico_identity; do
      case $tellico_identity in
        '~'/*) tellico_identity="$HOME/${tellico_identity#'~/'}" ;;
      esac
      if [ -r "$tellico_identity.pub" ]; then
        printf '%s\n' "$tellico_identity.pub"
        break
      fi
    done
}

# Classifies one non-interactive SSH attempt. Sets tellico_probe_result to
# ok, dns, unreachable, hostkey, denied, or unknown.
tellico_probe_ssh() {
  if tellico_probe_output=$(ssh -o BatchMode=yes \
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

  Add an alias to ~/.ssh/config, using your own cluster account if you
  have one and the key this device should offer:

    Host $ssh_host
      HostName tellico.icl.utk.edu
      User bbogale
      IdentityFile ~/.ssh/id_ed25519

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
# BatchMode reports as a plain "Permission denied".
tellico_key_locked() {
  tellico_privkey=${1%.pub}
  [ -r "$tellico_privkey" ] || return 1
  if ssh-keygen -y -P '' -f "$tellico_privkey" >/dev/null 2>&1; then
    return 1
  fi
  tellico_fingerprint=$(ssh-keygen -lf "$1" 2>/dev/null | awk '{print $2}')
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

tellico_explain_denied() {
  tellico_pubkey=$(tellico_device_pubkey)

  if [ -z "$tellico_pubkey" ]; then
    cat <<EOF

Next step: this device has no SSH key yet. Create one, then authorize it.

    ssh-keygen -t ed25519 -C "$(id -un)@$(uname -n)"
    ./doctor.sh

  Never copy a private key from another device; each one gets its own.
EOF
    return
  fi

  if tellico_key_locked "$tellico_pubkey"; then
    cat <<EOF

Next step: this device's key is encrypted and no SSH agent is holding it,
so the non-interactive check cannot use it. The key may well already be
authorized on Tellico.

    ssh-add ${tellico_pubkey%.pub}

  On macOS, store the passphrase in the keychain so this persists:

    ssh-add --apple-use-keychain ${tellico_pubkey%.pub}

  Then rerun: ./doctor.sh
EOF
    return
  fi

  cat <<EOF

Next step: this device's SSH key is not authorized on Tellico.

  Public key ($tellico_pubkey):

EOF
  sed 's/^/    /' "$tellico_pubkey"
  cat <<EOF

  From this machine, if the account still accepts passwords:

    ssh-copy-id -i $tellico_pubkey $ssh_host

  Or, from a machine that already works:

    ssh $ssh_host 'umask 077; mkdir -p ~/.ssh; echo "$(cat "$tellico_pubkey")" >> ~/.ssh/authorized_keys'

  Then rerun: ./install.sh
EOF
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
($(tellico_ssh_target | sed 's/@.*//')) cannot read the model API key:

    $TELLICO_REMOTE_KEY_PATH

  If you connect under a different cluster account, point the installer at
  the key your account can read:

    ./install.sh --remote-key-path /path/to/api-key

  Otherwise ask the allocation owner to grant read access to that file.
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
        tellico_denied_key=$(tellico_device_pubkey)
        if [ -n "$tellico_denied_key" ] && tellico_key_locked "$tellico_denied_key"; then
          tellico_status_line 'ssh auth' FAIL 'key is encrypted and not in an agent'
        else
          tellico_status_line 'ssh auth' FAIL 'key not authorized on Tellico'
        fi
        tellico_explain_denied
        ;;
      *)
        tellico_status_line network '?' 'ssh failed'
        tellico_explain_unknown
        ;;
    esac
    return 1
  fi

  if ssh -o BatchMode=yes -o ConnectTimeout="$TELLICO_CONNECT_TIMEOUT" \
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
  if tellico_allocation_output=$(ssh -o BatchMode=yes \
    -o ConnectTimeout="$TELLICO_CONNECT_TIMEOUT" "$ssh_host" qwen38-status 2>&1); then
    tellico_status_line allocation OK 'model servers running'
    return 0
  fi
  tellico_status_line allocation FAIL 'no running allocation'
  cat <<EOF

Next step: the model servers only exist while a Slurm allocation is active.

    ssh $ssh_host qwen38-submit
    ssh $ssh_host 'qwen38-status --wait'
    tellico-qwen-tunnel restart
EOF
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

  [ "$tellico_config_ok" = true ]
}
