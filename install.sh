#!/usr/bin/env bash
# The one sudo step. It creates the boundary — a system user, a root-owned admin binary, a
# never-cached sudo rule, four polkit actions, and the unit — and it installs no secrets: the
# key is generated later by `sudo chip402ctl setup`. Idempotent, so re-running after an edit is
# the normal way to work on it. `uninstall` reverses every path, user, and group this script
# created, including the TPM-sealed key.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run this with sudo"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Whoever invoked this, whether through sudo or through polkit. Everything owner-scoped below —
# the group membership, the drop-priv npm, and the panel plugin — belongs to them, not to root.
OWNER="${SUDO_USER:-}"
if [[ -z "$OWNER" && -n "${PKEXEC_UID:-}" ]]; then OWNER="$(id -nu "$PKEXEC_UID" 2>/dev/null || true)"; fi
LIB=/usr/local/lib/chip402

owner_home() {
  if [[ -n "$OWNER" ]]; then getent passwd "$OWNER" | cut -d: -f6; fi
}

uninstall() {
  echo "This removes the chip402 system user, the daemon, and the TPM-sealed key."
  if [[ -f /etc/chip402/config.json ]]; then
    echo "The Hedera account in /etc/chip402/config.json will still exist on chain; this machine will no longer hold the key."
  fi

  systemctl disable --now chip402 2>/dev/null || true
  rm -f /etc/systemd/system/chip402.service
  systemctl daemon-reload 2>/dev/null || true

  rm -rf /usr/local/lib/chip402
  rm -f /usr/local/bin/chip402ctl
  rm -f /etc/sudoers.d/chip402
  rm -f /usr/share/polkit-1/actions/dev.chip402.policy

  local home
  home="$(owner_home || true)"
  if [[ -n "$OWNER" ]]; then
    gpasswd -d "$OWNER" chip402 2>/dev/null || true
  fi
  if [[ -n "$home" ]]; then
    rm -rf "$home/.config/omarchy/plugins/chip402"
  fi

  rm -rf /var/lib/chip402 /etc/chip402 /run/chip402

  if id -u chip402 >/dev/null 2>&1; then
    userdel chip402
  fi
  if getent group chip402 >/dev/null 2>&1; then
    groupdel chip402
  fi

  echo
  echo "uninstalled."
  echo "  log out for the group change to finish."
}

if [[ "${1:-}" == "uninstall" ]]; then
  uninstall
  exit 0
fi

[[ -n "$OWNER" ]] || { echo "run this with sudo from a user session (SUDO_USER is needed to drop privileges for npm)"; exit 1; }
OWNER_HOME="$(owner_home)"
[[ -n "$OWNER_HOME" ]] || { echo "could not resolve home for $OWNER"; exit 1; }

# The daemon runs as another uid with ProtectHome=yes, so it cannot use a node that lives in
# $HOME. We copy a *system* node into $LIB rather than promoting a version-manager install.
# CHIP402_NODE overrides, but a path under /home or ~/.local is refused — that is the footgun.
NODE_SRC="${CHIP402_NODE:-$(command -v node || true)}"
NODE_SRC="$(readlink -f "$NODE_SRC" 2>/dev/null || true)"
[[ -x "$NODE_SRC" ]] || { echo "node not found; install the distro package (pacman -S nodejs npm) or set CHIP402_NODE to a system binary"; exit 1; }
case "$NODE_SRC" in
  /home/*|*/.local/*)
    echo "refusing $NODE_SRC — the daemon must not run a user-local node."
    echo "  pacman -S nodejs npm, or set CHIP402_NODE to a binary outside /home."
    exit 1
    ;;
esac
NODE_VERSION="$("$NODE_SRC" --version 2>/dev/null | tail -1)"
if [[ ! "$NODE_VERSION" =~ ^v[0-9] ]]; then
  echo "$NODE_SRC does not look like a node binary (said: $NODE_VERSION)"; exit 1
fi
if [[ "$(printf '%s\n' "v26.7.0" "$NODE_VERSION" | sort -V | head -1)" != "v26.7.0" ]]; then
  echo "node $NODE_VERSION is too old; 26.7.0 or newer is required"; exit 1
fi

# SECURITY: what runs is what was reviewed. Build the tree from the committed lockfile:
#
#   ci               exact versions from the lockfile, and it fails rather than updating it
#   --ignore-scripts no package gets to run code on this machine during install
#   --omit=dev       typescript is not shipped to a service that holds a key.
#
# npm itself is not run as root. The resolved node and npm-cli.js are handed to SUDO_USER
# with HOME set to theirs, so a bug in npm is not a root network client. CHIP402_NPM
# overrides, and must be the path to npm-cli.js.
[[ -f "$HERE/package-lock.json" ]] || { echo "package-lock.json is missing — this tree is not installable"; exit 1; }
NPM_CLI="${CHIP402_NPM:-}"
if [[ -z "$NPM_CLI" ]]; then
  for candidate in \
    "$(dirname "$NODE_SRC")/../lib/node_modules/npm/bin/npm-cli.js" \
    /usr/lib/node_modules/npm/bin/npm-cli.js \
    "$(dirname "$NODE_SRC")/npm"
  do
    candidate="$(readlink -f "$candidate" 2>/dev/null || true)"
    if [[ -f "$candidate" ]]; then NPM_CLI="$candidate"; break; fi
  done
fi
NPM_CLI="$(readlink -f "$NPM_CLI" 2>/dev/null || true)"
[[ -f "$NPM_CLI" ]] || { echo "npm-cli.js not found; install npm (pacman -S npm) or set CHIP402_NPM"; exit 1; }

DEPS="$(mktemp -d)"
trap 'rm -rf "$DEPS"' EXIT
cp "$HERE/package.json" "$HERE/package-lock.json" "$DEPS/"
chown -R "$OWNER":"$OWNER" "$DEPS"
echo "installing dependencies from the lockfile..."
( cd "$DEPS" && runuser -u "$OWNER" -- env HOME="$OWNER_HOME" "$NODE_SRC" "$NPM_CLI" ci --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null )

# --- the uid boundary -------------------------------------------------------------------------
# A system user with no login shell and no home in /home. This is what makes the key unreadable
# by anything running as me, which is the only boundary here that needs no judgment at runtime.
if ! id -u chip402 >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/chip402 --shell /usr/bin/nologin chip402
fi
# ...and the capability I am granting myself: membership of that group is what lets my shells and
# my agents reach the spend socket. Everything past this line is about what that capability may do.
usermod -aG chip402 "$OWNER"

install -d -o chip402 -g chip402 -m 0700 /var/lib/chip402
install -d -o root -g root -m 0755 /etc/chip402

# --- the daemon, out of my home --------------------------------------------------------------
# ProtectHome=yes only means something if the daemon has no reason to look there, so the code it
# runs is copied to /usr/local/lib and owned by root. The node binary is copied too, so a later
# distro upgrade does not change the interpreter under a running signer.
rm -rf "$LIB"
install -d -o root -g root -m 0755 "$LIB"
cp -r "$HERE/src" "$HERE/bin" "$HERE/package.json" "$HERE/package-lock.json" "$LIB/"
# The tree built from the lockfile a moment ago, not whatever is in the developer's checkout.
cp -r "$DEPS/node_modules" "$LIB/"
install -o root -g root -m 0755 "$NODE_SRC" "$LIB/node"
chown -R root:root "$LIB"
chmod -R go-w "$LIB"

# --- the only thing sudo and polkit will run --------------------------------------------------
# SECURITY: root-owned. If the admin binary were a script in my home, an agent would rewrite it
# and wait for me to type a password at it. The wrapper is a file in the tree, not generated
# here, so a reviewer can read what will land in /usr/local/bin without simulating this script.
mkdir -p /usr/local/bin
install -o root -g root -m 0755 "$HERE/bin/chip402ctl.sh" /usr/local/bin/chip402ctl

# SECURITY: timestamp_timeout=0 means a fifteen-minute sudo timestamp from some unrelated command
# can never be reused to raise a limit. Validated before it is installed, because a broken
# sudoers file locks the machine out of sudo entirely.
TMP_SUDOERS="$(mktemp)"
echo 'Defaults!/usr/local/bin/chip402ctl timestamp_timeout=0' > "$TMP_SUDOERS"
visudo -c -f "$TMP_SUDOERS" >/dev/null
install -o root -g root -m 0440 "$TMP_SUDOERS" /etc/sudoers.d/chip402
rm -f "$TMP_SUDOERS"

# --- the password dialog ----------------------------------------------------------------------
install -o root -g root -m 0644 "$HERE/ui/chip402.policy" /usr/share/polkit-1/actions/dev.chip402.policy

# A polkit action with no authentication agent to draw it fails silently, which is the exact
# failure this design exists to avoid. Omarchy runs its own agent inside omarchy-shell, so the
# check is that the plugin is there rather than that some separate daemon is installed.
if [[ ! -f /usr/share/omarchy/shell/plugins/polkit/PolkitAgent.qml ]]; then
  echo "warning: no Omarchy polkit agent found — the panel's RESUME button will do nothing."
  echo "         install any polkit authentication agent, or use 'sudo chip402ctl resume'."
fi

# --- the panel --------------------------------------------------------------------------------
# The plugin stays in the owner's config, because omarchy-shell runs as them and plugins are read
# from their home. It is the one part of this install that is not root-owned, and it is also the
# one part that cannot spend or authorise anything.
PLUGIN="$OWNER_HOME/.config/omarchy/plugins/chip402"
install -d -o "$OWNER" -g "$OWNER" -m 0755 "$PLUGIN"
cp "$HERE/ui/manifest.json" "$HERE/ui/Chip.qml" "$HERE/ui/Purse.qml" "$HERE/ui/ChipIcon.qml" "$PLUGIN/"
cp -r "$HERE/ui/assets" "$PLUGIN/"
chown -R "$OWNER":"$OWNER" "$PLUGIN"

# --- the unit ---------------------------------------------------------------------------------
install -o root -g root -m 0644 "$HERE/chip402.service" /etc/systemd/system/chip402.service
systemctl daemon-reload
systemctl enable chip402 >/dev/null

echo
echo "installed."
echo "  next:  sudo chip402ctl setup          generate a key, fund it, complete the account"
echo "         sudo systemctl start chip402"
echo "         omarchy plugin enable chip402 && omarchy restart shell"
echo
echo "  log out and back in — group chip402 is what lets you reach the spend socket."
