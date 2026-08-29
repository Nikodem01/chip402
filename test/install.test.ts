// The installer is the privilege boundary. These tests read the script and the files it copies,
// because running it as root belongs to a live machine, not to `npm test`.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const installer = readFileSync(join(root, "install.sh"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const wrapperPath = join(root, "bin/chip402ctl.sh");

test("uninstall is a first-class verb, not a comment", () => {
  assert.match(installer, /\[\[ "\$\{1:-\}" == "uninstall" \]\]/, "install.sh does not dispatch on uninstall");
  assert.match(installer, /uninstall\(\)/, "install.sh has no uninstall function");
});

test("uninstall deletes the chip402 user and group after stopping the unit", () => {
  const fn = uninstallBody();
  assert.match(fn, /systemctl disable --now chip402/, "the unit is still enabled after uninstall");
  assert.match(fn, /userdel chip402/, "the chip402 uid survives uninstall");
  assert.match(fn, /groupdel chip402/, "the chip402 group survives uninstall");
  const disableAt = fn.indexOf("systemctl disable --now chip402");
  const userdelAt = fn.indexOf("userdel chip402");
  assert.ok(disableAt >= 0 && userdelAt > disableAt, "userdel runs while the service still holds the uid");
});

test("uninstall removes every path the installer created, including the sealed key", () => {
  const fn = uninstallBody();
  for (const path of [
    "/usr/local/lib/chip402",
    "/usr/local/bin/chip402ctl",
    "/etc/sudoers.d/chip402",
    "/usr/share/polkit-1/actions/dev.chip402.policy",
    "/var/lib/chip402",
    "/etc/chip402",
    "/etc/systemd/system/chip402.service",
    ".config/omarchy/plugins/chip402",
  ]) {
    assert.ok(fn.includes(path), `uninstall never mentions ${path}`);
  }
  assert.doesNotMatch(fn, /userdel -r/, "userdel -r follows a home we do not control; delete known paths first");
});

test("the installer never uses a login shell to find node or npm", () => {
  assert.doesNotMatch(installer, /runuser\s+-l/, "runuser -l sources the invoking user's rc files as part of a root install");
  assert.doesNotMatch(installer, /su\s+-l/, "su -l is the same login-shell smell");
});

test("npm ci runs as the invoking user, not as root", () => {
  assert.match(
    installer,
    /runuser -u "\$OWNER" -- env HOME="\$OWNER_HOME" "\$NODE_SRC" "\$NPM_CLI" ci --ignore-scripts/,
    "the lockfile install is not dropped to SUDO_USER",
  );
  assert.doesNotMatch(
    installer,
    /^\s*\( cd "\$DEPS" && "\$NODE_SRC" "\$NPM_CLI" ci/m,
    "the old root npm ci line is still there",
  );
});

test("a node binary under /home is refused, even via CHIP402_NODE", () => {
  assert.match(installer, /\/home\/\*/, "install.sh does not refuse a user-local node");
  assert.match(installer, /CHIP402_NODE/, "the override is gone rather than constrained");
});

test("chip402ctl is a file in the tree, copied, not generated at install time", () => {
  assert.equal(existsSync(wrapperPath), true, "bin/chip402ctl.sh is missing");
  const wrapper = readFileSync(wrapperPath, "utf8");
  assert.match(wrapper, /^#!/);
  assert.match(
    wrapper,
    /exec \/usr\/local\/lib\/chip402\/node \/usr\/local\/lib\/chip402\/bin\/chip402ctl\.ts/,
    "the wrapper does not exec the installed node and the admin CLI",
  );
  assert.match(
    installer,
    /bin\/chip402ctl\.sh/,
    "install.sh does not copy the checked-in wrapper",
  );
  assert.doesNotMatch(
    installer,
    /cat > \/usr\/local\/bin\/chip402ctl/,
    "install.sh still generates /usr/local/bin/chip402ctl with a heredoc",
  );
});

test("the README pins a release, documents uninstall, and does not ask for Node 22", () => {
  assert.match(readme, /git checkout v0\.1\.0/, "the quickstart still clones a moving default branch");
  assert.match(readme, /install\.sh uninstall/, "the README never says how to take chip402 off the machine");
  assert.match(readme, /26\.7\.0/, "the README does not name the Node version the installer requires");
  assert.doesNotMatch(readme, /Node\.js 22/, "the README still claims Node 22");
  assert.match(
    readme,
    /bar widget is unprivileged|widget is unprivileged/i,
    "the README does not say the widget and the signer have different privilege",
  );
});

function uninstallBody(): string {
  const match = /uninstall\(\) \{([\s\S]*?)\n\}/.exec(installer);
  assert.ok(match, "could not find uninstall() { ... }");
  return match[1]!;
}
