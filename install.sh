#!/usr/bin/env bash
# The one sudo step. It creates the boundary — a system user, a root-owned admin binary, a
# never-cached sudo rule, four polkit actions, and the unit — and it installs no secrets: the
# key is generated later by `sudo chip402ctl setup`. Idempotent, so re-running after an edit is
# the normal way to work on it.
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run this with sudo"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Whoever invoked this, whether through sudo or through polkit. Everything owner-scoped below —
# the group membership and the panel plugin — belongs to them, not to root.
OWNER="${SUDO_USER:-}"
if [[ -z "$OWNER" && -n "${PKEXEC_UID:-}" ]]; then OWNER="$(id -nu "$PKEXEC_UID" 2>/dev/null || true)"; fi
LIB=/usr/local/lib/chip402

# The daemon runs as another uid with ProtectHome=yes, so it cannot use a node that lives in my
# home — a version-manager install is the normal case here. Resolve the one I am using, check it
# is new enough for --permission and for running .ts with no build step, and take a root-owned
# copy. The binary is self-contained; only libc and libstdc++ come from the system.
# Root's PATH will not have a version-manager shim on it, so if node is not on this PATH, ask the
# invoking user where theirs is — `mise which` rather than the shim, because the daemon needs the
# real binary and not a shell wrapper. CHIP402_NODE overrides both.
NODE_SRC="${CHIP402_NODE:-$(command -v node || true)}"
if [[ -z "$NODE_SRC" && -n "$OWNER" ]]; then
  NODE_SRC="$(runuser -l "$OWNER" -c 'mise which node 2>/dev/null || command -v node' 2>/dev/null | tail -1)"
fi
NODE_SRC="$(readlink -f "$NODE_SRC" 2>/dev/null || true)"
[[ -x "$NODE_SRC" ]] || { echo "node not found; set CHIP402_NODE to a node 26.7.0+ binary"; exit 1; }
NODE_VERSION="$("$NODE_SRC" --version 2>/dev/null | tail -1)"
if [[ ! "$NODE_VERSION" =~ ^v[0-9] ]]; then
  echo "$NODE_SRC does not look like a node binary (said: $NODE_VERSION)"; exit 1
fi
if [[ "$(printf '%s\n' "v26.7.0" "$NODE_VERSION" | sort -V | head -1)" != "v26.7.0" ]]; then
  echo "node $NODE_VERSION is too old; 26.7.0 or newer is required"; exit 1
fi
# SECURITY: what runs is what was reviewed. The old check was that node_modules merely *existed*
# and then copied it wholesale, so the daemon ran whatever the developer happened to have — not
# provably from the lockfile, and not provably installed without lifecycle scripts. This builds
# the tree itself, into a directory of its own, from the committed package-lock.json:
#
#   ci               exact versions from the lockfile, and it fails rather than updating it
#   --ignore-scripts no package gets to run code on this machine during install
#   --omit=dev       typescript is not shipped to a service that holds a key. (@types packages
#                    can still arrive as transitive runtime deps; they are inert type files.)
#
# npm is run as a script under the same node we just resolved, rather than through whatever `npm`
# is on root's PATH — a version-manager install puts npm-cli.js next to its own node, and running
# a different one would build the tree against a different runtime than the daemon uses.
# CHIP402_NPM overrides, and must be the path to npm-cli.js.
[[ -f "$HERE/package-lock.json" ]] || { echo "package-lock.json is missing — this tree is not installable"; exit 1; }
NPM_CLI="${CHIP402_NPM:-$(readlink -f "$(dirname "$NODE_SRC")/npm" 2>/dev/null || true)}"
if [[ ! -f "$NPM_CLI" ]]; then NPM_CLI="$(readlink -f "$(command -v npm || true)" 2>/dev/null || true)"; fi
[[ -f "$NPM_CLI" ]] || { echo "npm-cli.js not found next to $NODE_SRC; set CHIP402_NPM"; exit 1; }

DEPS="$(mktemp -d)"
trap 'rm -rf "$DEPS"' EXIT
cp "$HERE/package.json" "$HERE/package-lock.json" "$DEPS/"
echo "installing dependencies from the lockfile..."
( cd "$DEPS" && "$NODE_SRC" "$NPM_CLI" ci --ignore-scripts --omit=dev --no-audit --no-fund >/dev/null )

# --- the uid boundary -------------------------------------------------------------------------
# A system user with no login shell and no home in /home. This is what makes the key unreadable
# by anything running as me, which is the only boundary here that needs no judgment at runtime.
if ! id -u chip402 >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/chip402 --shell /usr/bin/nologin chip402
fi
# ...and the capability I am granting myself: membership of that group is what lets my shells and
# my agents reach the spend socket. Everything past this line is about what that capability may do.
if [[ -n "$OWNER" ]]; then usermod -aG chip402 "$OWNER"; fi

install -d -o chip402 -g chip402 -m 0700 /var/lib/chip402
install -d -o root -g root -m 0755 /etc/chip402

# --- the daemon, out of my home --------------------------------------------------------------
# ProtectHome=yes only means something if the daemon has no reason to look there, so the code it
# runs is copied to /usr/local/lib and owned by root.
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
# and wait for me to type a password at it.
# `mkdir -p` rather than `install -d`, because this directory belongs to the distribution on every
# machine that has one and there is no reason for this script to restate its mode. It is only ever
# created on a system minimal enough not to ship it, where the redirect below would otherwise fail
# with a bash error that says nothing about chip402.
mkdir -p /usr/local/bin
cat > /usr/local/bin/chip402ctl <<EOF
#!/usr/bin/env bash
exec $LIB/node $LIB/bin/chip402ctl.ts "\$@"
EOF
chown root:root /usr/local/bin/chip402ctl
chmod 0755 /usr/local/bin/chip402ctl

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
if [[ -n "$OWNER" ]]; then
  OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
  PLUGIN="$OWNER_HOME/.config/omarchy/plugins/chip402"
  install -d -o "$OWNER" -g "$OWNER" -m 0755 "$PLUGIN"
  cp "$HERE/ui/manifest.json" "$HERE/ui/Chip.qml" "$HERE/ui/Purse.qml" "$HERE/ui/ChipIcon.qml" "$PLUGIN/"
  cp -r "$HERE/ui/assets" "$PLUGIN/"
  chown -R "$OWNER":"$OWNER" "$PLUGIN"
fi

# --- the unit ---------------------------------------------------------------------------------
install -o root -g root -m 0644 "$HERE/chip402.service" /etc/systemd/system/chip402.service
systemctl daemon-reload
systemctl enable chip402 >/dev/null

echo
echo "installed."
echo "  next:  sudo chip402ctl setup          generate a key, fund it, complete the account"
echo "         sudo systemctl start chip402"
echo "         omarchy plugin enable chip402 && omarchy restart shell"
if [[ -n "$OWNER" ]]; then
  echo
  echo "  log out and back in — group chip402 is what lets you reach the spend socket."
fi
