import QtQuick
import Quickshell
import Quickshell.Io

// The panel's only connection to the daemon: one unix socket, newline-delimited JSON. The
// daemon pushes a status frame on connect and after every change, so nothing here polls for
// state and there is no refresh interval to configure — what arrives is what is drawn.
Item {
  id: root

  // The spend socket — 0660 chip402:chip402. The panel is in that group like every other
  // process I run, so it gets exactly the authority I have: read the purse, and stop it.
  property string spendSocket: "/run/chip402/spend.sock"
  property var status: null

  readonly property bool live: status !== null
  // Why we cannot see the daemon, which is two very different problems with two different
  // answers. QLocalSocket's codes: 2 is ServerNotFoundError — no socket file, so nothing is
  // running — and 3 is SocketAccessError, which here means one thing: this session started
  // before you were added to the chip402 group, so the socket is there and you are not in the
  // group that may open it. Only a fresh login fixes that; a button cannot.
  property int socketError: -1
  readonly property bool notRunning: !live && socketError === 2
  readonly property bool notPermitted: !live && socketError === 3
  readonly property bool paused: status ? status.paused === true : true
  readonly property bool mainnet: status ? status.live === true : false
  readonly property string networkLabel: status ? String(status.networkLabel) : ""
  readonly property string accountId: status && status.accountId ? String(status.accountId) : ""
  readonly property string hashscan: status ? String(status.hashscan) : ""
  // The address to send money to. It arrives derived from the key the daemon holds, not read
  // from a config file — see openWallet. Nothing running as me can change what this says.
  readonly property string evmAddress: status && status.evmAddress ? String(status.evmAddress) : ""
  // Three states, and they mean three different things. true: the chain agrees this key controls
  // that account. false: it says a different key does — a warning the daemon acts on, not just
  // draws. null: we could not tell, which covers a mirror node we could not reach and an account
  // whose key shape we do not claim to understand. Only false is a problem.
  readonly property var accountVerified: status ? status.accountVerified : null
  // The daemon has read `false` three times, a minute apart, and is now refusing to pay. This is
  // the difference between a badge and a consequence, so the panel says which one it is.
  readonly property bool keyMismatch: status ? status.keyMismatch === true : false
  // A transaction has been signed and the chain has not shown it yet. Payment is refused for the
  // few seconds that lasts, which is worth saying rather than leaving as a mysterious denial.
  readonly property int inFlight: status ? (status.inFlight || 0) : 0
  // The account id with its HIP-15 checksum: five letters derived from the id and the network,
  // so they change completely if any digit does. Five characters is a comparison a human will
  // actually make; forty-two hex characters is one they will skip.
  readonly property string accountWithChecksum: status && status.accountWithChecksum ? String(status.accountWithChecksum) : ""
  // When the mirror node last answered: the balance, what has been spent today, and whether this
  // key still controls this account all date from that moment. Zero means it never has, and the
  // daemon will not pay until it does.
  readonly property real confirmedAt: status ? Number(status.chainAt) : 0
  readonly property bool chainAnswered: confirmedAt > 0
  // When the daemon will look again without being asked. Zero while it never has — the same
  // condition as `chainAnswered`, because until the chain answers once there is nothing to be due.
  readonly property real nextReadAt: status ? Number(status.nextReadAt) : 0
  // Before setup has run there is no account, only an address to fund — the panel shows that
  // instead of a purse.
  readonly property bool awaitingFunding: live && accountId === ""

  function assetOf(key) {
    return status && status.assets ? status.assets[key] : null
  }

  // Base units to the string a human reads. The decimals and the symbol come down the socket in
  // the status frame, so the panel never hardcodes a currency and never needs a conversion.
  function money(units, asset) {
    if (!asset) return ""
    var value = String(units === undefined || units === null ? "0" : units)
    var padded = value.length > asset.decimals ? value : "0".repeat(asset.decimals - value.length + 1) + value
    var whole = padded.slice(0, padded.length - asset.decimals)
    var fraction = asset.decimals > 0 ? padded.slice(padded.length - asset.decimals) : ""
    while (fraction.length > asset.minDisplayDecimals && fraction.charAt(fraction.length - 1) === "0")
      fraction = fraction.slice(0, fraction.length - 1)
    return asset.prefix + whole + (fraction.length > 0 ? "." + fraction : "")
  }

  // What could still be spent this second — which is exactly what policy.ts would allow, because
  // it applies both of these tests: what is left of today's allowance, and what is actually in
  // the purse. Whichever runs out first is the real leash, and it is the number worth putting on
  // a bar: "$8.38" next to a wallet reads as money you have, and here that is true.
  //
  // Plain numbers rather than BigInt: a day's pocket money in base units is nowhere near 2^53.
  // The result goes back out as a string because that is what the socket speaks and what money()
  // expects.
  function remainingToday(asset) {
    if (!asset) return "0"
    var left = Number(asset.allowance) - Number(asset.spent)
    return String(Math.max(0, Math.min(left, Number(asset.balance))))
  }

  // 0..1, for the allowance bar. Guarded because a zero allowance is a legal state — it is how
  // an asset is switched off.
  function spentFraction(asset) {
    if (!asset) return 0
    var allowance = Number(asset.allowance)
    if (!(allowance > 0)) return 0
    return Math.min(1, Number(asset.spent) / allowance)
  }

  function resetsInText() {
    if (!status) return ""
    var ms = Number(status.resetsAt) - Date.now()
    if (ms <= 0) return "resets now"
    var hours = Math.floor(ms / 3600000)
    return hours >= 1 ? "resets in " + hours + "h" : "resets in " + Math.max(1, Math.round(ms / 60000)) + "m"
  }

  // The same rule money.ts enforces on the far side: digits, one optional dot, and no more
  // decimal places than the asset actually has. Checked here so a typo is a field that will not
  // commit, rather than a password prompt that is going to fail after you have typed it.
  function isValidAmount(text, asset) {
    if (!asset) return false
    var match = /^\d+(?:\.(\d+))?$/.exec(String(text).trim())
    return match !== null && (match[1] === undefined || match[1].length <= asset.decimals)
  }

  // SECURITY: execDetached with an argv array, and no shell anywhere in this file. Omarchy's
  // own helper passes the same argv through a login shell (`-lc`) first, which is safe against
  // injection and still sources the user's profile before every copy and every explorer link —
  // scripts an agent running as me can write, on the path that follows a payment. There is no
  // reason for a profile to run here, so it does not.
  //
  // Onto the clipboard rather than onto the screen to be retyped: an address copied by eye is an
  // address with a typo in it, and a typo in an address is money gone.
  function copy(text) {
    if (!text) return
    Quickshell.execDetached(["wl-copy", "--", String(text)])
  }

  // A payment is only half a payment if you cannot go and look at it. The transaction id is ours
  // — read out of the bytes the daemon signed — and HashScan is the second source that says what
  // it moved.
  function openReceipt(txId) {
    if (!txId || !status) return
    Quickshell.execDetached(["xdg-open", String(status.hashscan) + "transaction/" + String(txId)])
  }

  // The account on a public explorer. This is the out-of-band check: a panel that lied about the
  // address cannot also change what the chain says, so comparing the two is the one verification
  // that does not rest on trusting this panel.
  function openAccount() {
    if (!status || accountId === "") return
    Quickshell.execDetached(["xdg-open", String(status.hashscan) + "account/" + accountId])
  }

  // Deliberately precise in the first minute. The daemon takes a reading whenever the panel is
  // opened, so by the time anybody reads this line the answer is nearly always a few seconds old —
  // and a line that said "just now" every single time would be telling the truth in a way that
  // carries no information and looks stuck. Seconds that tick are the difference between a figure
  // that is fresh and a panel that is alive.
  function agoText(at) {
    if (!at) return ""
    var seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
    if (seconds < 3) return qsTr("just now")
    if (seconds < 90) return qsTr("%1s ago").arg(seconds)
    var minutes = Math.round(seconds / 60)
    return minutes < 60 ? qsTr("%1 min ago").arg(minutes) : qsTr("%1 h ago").arg(Math.round(minutes / 60))
  }

  // How long until the daemon looks again on its own. A real deadline rather than a guess: it reads
  // when nothing else has for a quarter of an hour, so the moment is fifteen minutes after the last
  // reading whatever caused it, and the daemon sends that moment rather than the panel inventing it
  // from an interval whose phase it cannot know.
  function untilText(at) {
    if (!at) return ""
    var seconds = Math.round((at - Date.now()) / 1000)
    if (seconds <= 0) return qsTr("checking soon")
    if (seconds < 60) return qsTr("next in %1s").arg(seconds)
    var minutes = Math.ceil(seconds / 60)
    return minutes < 60 ? qsTr("next in %1 min").arg(minutes) : qsTr("next in %1 h").arg(Math.round(minutes / 60))
  }

  // The kill switch. One line on the cheap socket, no password, no confirmation — an agent that
  // pauses the purse has only denied itself, so there is nothing to protect here.
  function pause() {
    if (root.linked) link.item.write(JSON.stringify({ cmd: "pause" }) + "\n")
  }

  // Ask for a reading. `purse` answers with what the daemon already has and takes a fresh reading
  // alongside, which arrives a moment later as an ordinary push — so this changes nothing on its
  // own and is safe to call whenever somebody might be looking. The daemon drops a reading taken
  // seconds after the last one, so calling it often costs nothing either.
  //
  // Nothing in this file calls it on a clock. What is on screen is what the daemon pushed, and the
  // two places that ask — the popup opening, and the seconds somebody spends watching the top-up
  // panel for money to land — are in Chip.qml, where the reason for asking is visible.
  function refresh() {
    if (root.linked) link.item.write(JSON.stringify({ cmd: "purse" }) + "\n")
  }

  // Everything privileged goes the other way, through polkit. argv only, never a shell string:
  // the values come from the daemon's own preset list, but a command line assembled by string
  // concatenation is a habit worth not having near a password prompt.
  function authorise(args) {
    if (privileged.running) return
    privileged.command = ["pkexec", "/usr/local/bin/chip402ctl"].concat(args)
    privileged.running = true
  }

  // Starting the unit, through the same root-owned binary as every other privileged verb — not
  // `pkexec systemctl start chip402`, which is what this used to be. That form matches none of
  // our polkit actions, so the dialog fell back to "Authentication is required to run a program
  // as another user": a caption that says nothing about chip402 and looks the same as `pkexec` of
  // anything else. Every privileged thing this file can ask for is now bound by exec.path to
  // /usr/local/bin/chip402ctl, so a prompt without a chip402 sentence on it is a prompt to refuse.
  function startDaemon() { authorise(["start"]) }

  function resume() { authorise(["resume"]) }
  function setAllowance(key, amount) { authorise(["allowance", key, amount]) }
  function setMaxPayment(key, amount) { authorise(["max", key, amount]) }

  function ingest(line) {
    if (line.length === 0) return
    var frame = JSON.parse(line)
    // Replies to our own `pause` carry an id; the unsolicited status frames do not. Only the
    // latter are state.
    if (frame.type === "status") root.status = frame
  }

  // Whether we currently have a live connection to the daemon. Read through the Loader, because
  // the Socket underneath is replaced rather than reused — see the retry below.
  readonly property bool linked: link.item ? link.item.connected === true : false

  // A daemon restart, or a machine where it has not been started yet. Retry quietly; the panel
  // says which of the two it is rather than showing a code nobody can act on.
  //
  // The retry has to build a *new* Socket, which is why this one lives in a Loader. A Quickshell
  // Socket that has once failed to connect stays wedged: assigning `connected = true` again is a
  // no-op, because the desired-state flag it writes is already true, and reassigning `path` does
  // not reset it either. Both were measured against a socket taken away and put back — neither
  // reconnected, and destroying the object was the only thing that did.
  //
  // This was a real three-hour outage on my own machine and not a theoretical one. A single
  // `systemctl restart chip402` left the panel showing START for as long as the shell ran, and
  // pressing START then spent a password asking systemd to start a daemon that was already up.
  // test/panel.test.ts drives this file against a socket that goes away and comes back.
  Loader {
    id: link
    active: true
    sourceComponent: Component {
      Socket {
        path: root.spendSocket
        connected: true
        parser: SplitParser {
          splitMarker: "\n"
          onRead: function (line) { root.ingest(line) }
        }
        onConnectionStateChanged: {
          if (!connected) root.status = null
          else root.socketError = -1
        }
        onError: function (code) { root.socketError = code }
      }
    }
  }

  Timer {
    interval: 5000
    running: !root.linked
    repeat: true
    onTriggered: {
      root.status = null
      link.active = false
      link.active = true
    }
  }

  // No stdout is read from this on purpose: the answer the panel cares about arrives as a fresh
  // status frame on the socket, so a successful password and a cancelled dialog need no
  // different handling. Cancel and nothing changes — the chip staying put is the feedback.
  Process { id: privileged }
}
