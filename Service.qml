import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import "Model.js" as Model

Item {
  id: root

  property var settings: ({})

  property bool paused: false
  property bool configured: false
  property bool associated: false
  property bool daemonUp: false
  property string accountId: ""
  property string evmAddress: ""
  property string merchantAccountId: ""
  property string balanceMicro: "0"
  property string spentTodayMicro: "0"
  property string dailyCapMicro: "10000000"
  property string perRequestMicro: "1000000"
  property bool hollow: false
  property bool balanceFresh: false
  property string pendingMicro: "0"
  property string feePayer: ""
  property string facilitatorError: ""
  property string floatWarning: ""
  property var allowHosts: []
  property var ledger: []
  property string hashscan: ""
  property string lastError: ""
  property string actionStatus: ""
  property bool busy: false

  // The daemon listens on a unix socket, so filesystem permissions are the authorization and
  // no web page can reach it. QML's XMLHttpRequest speaks TCP only, so requests go through
  // curl --unix-socket instead.
  readonly property string socketPath: Quickshell.env("CHIP402_SOCKET")
    || ((Quickshell.env("XDG_RUNTIME_DIR") || (root.stateDir + "/run")) + "/chip402.sock")

  // Same override the daemon's paths.mjs honours, so a second profile never touches the live
  // state. Only the socket location is derived from it; the panel never reads state off disk.
  readonly property string stateDir:
    Quickshell.env("CHIP402_STATE_DIR") || (Quickshell.env("HOME") + "/.local/state/chip402")

  // The daemon is `node <script>`. Which node that is comes from the session's PATH; set
  // CHIP402_NODE when node lives somewhere only a login shell would have found (nvm, asdf).
  readonly property string nodeBinary: Quickshell.env("CHIP402_NODE") || "node"

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 15, 5, 3600)
  readonly property string phase: Model.setupPhase(evmAddress, accountId, hollow, associated, balanceMicro)
  readonly property bool ready: phase === "ready"
  readonly property bool active: ready && !paused
  readonly property string statusText: !ready ? "Needs funding" : (paused ? "Paused" : "Live")
  readonly property string displayError: Model.humanError(lastError)
  readonly property string pluginDir: pluginPath()

  readonly property int maxErrorChars: 240

  function pluginPath() {
    var u = Qt.resolvedUrl(".").toString()
    if (u.indexOf("file://") === 0) u = decodeURIComponent(u.substring(7))
    if (u.length > 0 && u.charAt(u.length - 1) === "/") u = u.substring(0, u.length - 1)
    return u
  }

  function setting(name, fallback) {
    var value = settings ? settings[name] : undefined
    return value === undefined || value === null ? fallback : value
  }

  function intSetting(name, fallback, min, max) {
    var n = parseInt(String(setting(name, fallback)), 10)
    if (!isFinite(n)) n = fallback
    if (n < min) n = min
    if (n > max) n = max
    return n
  }

  // Every field arrives already clamped and stripped by Model.parseState, because some of
  // them end up in host shell components this plugin cannot set textFormat on.
  function applyState(raw) {
    var parsed = Model.parseState(raw)
    paused = parsed.paused === true
    configured = parsed.configured === true
    associated = parsed.associated === true
    accountId = parsed.accountId
    evmAddress = parsed.evmAddress
    merchantAccountId = parsed.merchantAccountId
    balanceMicro = parsed.balanceMicro
    spentTodayMicro = parsed.spentTodayMicro
    dailyCapMicro = parsed.dailyCapMicro
    perRequestMicro = parsed.perRequestMicro
    hollow = parsed.hollow === true
    balanceFresh = parsed.balanceFresh === true
    pendingMicro = parsed.pendingMicro
    feePayer = parsed.feePayer
    facilitatorError = parsed.facilitatorError
    floatWarning = parsed.floatWarning
    allowHosts = parsed.allowHosts
    // Whatever network the daemon is on — never a hardcoded explorer.
    hashscan = parsed.hashscan
    ledger = parsed.ledger
    lastError = parsed.lastError
  }

  // argv, never a shell string: nothing here is parsed by bash, so no quoting rule stands
  // between a hostname in a ledger row and a command line. curl gets a deadline and a byte
  // ceiling both, because the collector below has no limit of its own — the producer is the
  // only place a limit can be enforced.
  function curlFor(path, body) {
    var argv = [
      "curl", "-sS", "--fail-with-body",
      "--max-time", "15",
      "--connect-timeout", "5",
      "--max-filesize", "262144",
      "--unix-socket", socketPath
    ]
    if (body !== null && body !== undefined) {
      argv.push("-H", "content-type: application/json")
      argv.push("-d", JSON.stringify(body))
    }
    argv.push("http://chip402.local" + path)
    return argv
  }

  // Process is single-shot, so calls queue rather than clobbering one another. The queue is
  // bounded: a daemon that stops answering must not grow a backlog for the whole session.
  property var pending: []
  readonly property int maxPending: 8

  function post(path, body, okMessage) {
    if (pending.length >= maxPending) return
    pending.push({ path: path, body: body, okMessage: okMessage || "" })
    drain()
  }

  function drain() {
    if (busy || pending.length === 0) return
    busy = true
    var job = pending.shift()
    apiProcess.okMessage = job.okMessage
    apiProcess.running = false
    apiProcess.command = curlFor(job.path, job.body)
    apiProcess.running = true
  }

  // A read, not a write: GET /status returns the same view every mutating call returns, so
  // the panel never has to open the daemon's state file to find out what happened.
  function refresh() {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].path === "/status") return
    }
    post("/status", null, "")
  }

  function pause() {
    paused = true
    post("/pause", { paused: true }, "chip402 paused")
  }

  function resume() {
    paused = false
    post("/pause", { paused: false }, "Agents can spend")
  }

  function toggle() {
    if (paused) resume()
    else pause()
  }

  function setDailyCap(usd) {
    post("/caps", { dailyMicro: Model.usdToMicro(usd) })
  }

  function setPerRequestCap(usd) {
    post("/caps", { perRequestMicro: Model.usdToMicro(usd) })
  }

  // These are account ids and explorer links — public identifiers, not secrets — so argv is
  // where they belong. A password would have to go over stdin instead.
  function copy(text) {
    var value = String(text || "")
    if (value === "") return
    Quickshell.execDetached(["wl-copy", "--", value])
    actionStatus = "Copied"
    actionStatusTimer.restart()
  }

  // The launcher is handed whatever came back over the socket, so the shape is checked here
  // rather than assumed: https only, no whitespace, and a length a real explorer link fits in.
  function openUrl(url) {
    var value = String(url || "")
    if (value.indexOf("https://") !== 0) return
    if (value.length > 512) return
    if (/\s/.test(value)) return
    Quickshell.execDetached(["omarchy-launch-browser", value])
  }

  // Rebuilt from the transaction id and the daemon's explorer base rather than taken from
  // the row's own link field, so a seller-chosen string is never what gets launched.
  function openHashscan(row) {
    if (!row) return
    var url = Model.hashscanTx(row.txId, hashscan)
    if (url !== "") openUrl(url)
  }

  function openAccount() {
    if (accountId !== "") openUrl(Model.hashscanAccount(accountId, hashscan))
    else openUrl("https://portal.hedera.com/faucet")
  }

  function runSetup() {
    actionStatus = "Writing operator key…"
    actionStatusTimer.restart()
    setupProcess.running = false
    setupProcess.command = [nodeBinary, pluginDir + "/bin/chip402", "setup"]
    setupProcess.running = true
  }

  Timer {
    id: actionStatusTimer
    interval: 2200
    repeat: false
    onTriggered: root.actionStatus = ""
  }

  Timer {
    id: refreshTimer
    interval: root.refreshIntervalSec * 1000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  property int daemonAttempts: 0
  readonly property int maxDaemonAttempts: 5
  property bool daemonHandedOff: false

  // No StdioCollector on this one, on purpose: it runs for the whole session, so a collector
  // would buffer every line it ever writes inside the shell process with nothing draining it.
  // The daemon keeps its own rotated log at ~/.local/state/chip402/chip402d.log.
  Process {
    id: daemon
    running: true
    command: [root.nodeBinary, root.pluginDir + "/daemon/chip402d.mjs"]
    onRunningChanged: if (running) root.daemonUp = true
    onExited: function (code) {
      root.daemonUp = false
      // Exit 0 means another chip402d already owns the socket. That one serves us, and
      // starting ours again would spawn a node process on every refresh for the whole session.
      if (code === 0) {
        root.daemonHandedOff = true
        return
      }
      if (root.daemonAttempts < root.maxDaemonAttempts) {
        root.daemonAttempts += 1
        restartDaemon.interval = 2000 * root.daemonAttempts
        restartDaemon.restart()
      } else {
        root.lastError = "chip402d could not start — see ~/.local/state/chip402/chip402d.log"
      }
    }
  }

  Timer {
    id: restartDaemon
    interval: 2000
    repeat: false
    onTriggered: if (!daemon.running && !root.daemonHandedOff) daemon.running = true
  }

  Process {
    id: apiProcess
    property string okMessage: ""
    running: false
    command: []
    stdout: StdioCollector { id: apiOut; waitForEnd: true }
    stderr: StdioCollector { id: apiErr; waitForEnd: true }
    onExited: function (code) {
      root.busy = false
      if (code === 0) {
        root.applyState(apiOut.text)
        root.daemonAttempts = 0
        if (okMessage !== "") {
          root.actionStatus = okMessage
          actionStatusTimer.restart()
        }
      } else {
        var message = String(apiOut.text || apiErr.text || "").trim() || ("Request failed (" + code + ")")
        root.lastError = Model.clamp(message, root.maxErrorChars)
      }
      root.drain()
    }
  }

  Process {
    id: setupProcess
    running: false
    command: []
    onExited: function (code) {
      if (code === 0) {
        root.actionStatus = "Key ready — send a little HBAR to that address"
        root.refresh()
      } else {
        root.lastError = "Setup failed"
      }
      actionStatusTimer.restart()
    }
  }
}
