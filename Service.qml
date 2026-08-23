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
  readonly property string socketPath:
    (Quickshell.env("XDG_RUNTIME_DIR") || (Quickshell.env("HOME") + "/.local/state/chip402/run")) + "/chip402.sock"

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 15, 5, 3600)
  readonly property string phase: Model.setupPhase(evmAddress, accountId, hollow, associated, balanceMicro)
  readonly property bool ready: phase === "ready"
  readonly property bool active: ready && !paused
  readonly property string statusText: !ready ? "Needs funding" : (paused ? "Paused" : "Live")
  readonly property string displayError: Model.humanError(lastError)
  readonly property string pluginDir: pluginPath()

  property FileView stateFile: FileView {
    path: Quickshell.env("HOME") + "/.local/state/chip402/state.json"
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.applyState(text())
    onLoadFailed: root.applyState("")
  }

  function pluginPath() {
    var u = Qt.resolvedUrl(".").toString()
    if (u.indexOf("file://") === 0) u = u.substring(7)
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

  function applyState(raw) {
    var parsed = Model.parseState(raw)
    paused = parsed.paused === true
    configured = parsed.configured === true
    associated = parsed.associated === true
    accountId = String(parsed.accountId || "")
    evmAddress = String(parsed.evmAddress || "")
    merchantAccountId = String(parsed.merchantAccountId || "")
    balanceMicro = String(parsed.balanceMicro || "0")
    spentTodayMicro = String(parsed.spentTodayMicro || "0")
    dailyCapMicro = String(parsed.dailyCapMicro || "10000000")
    perRequestMicro = String(parsed.perRequestMicro || "1000000")
    hollow = parsed.hollow === true
    balanceFresh = parsed.balanceFresh === true
    pendingMicro = String(parsed.pendingMicro || "0")
    feePayer = String(parsed.feePayer || "")
    facilitatorError = String(parsed.facilitatorError || "")
    floatWarning = String(parsed.floatWarning || "")
    allowHosts = parsed.allowHosts || []
    // Whatever network the daemon is on — never a hardcoded explorer.
    hashscan = String(parsed.hashscan || "")
    ledger = parsed.ledger || []
    lastError = String(parsed.lastError || "")
  }

  function quote(value) {
    return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
  }

  function curlFor(path, body) {
    return [
      "bash", "-lc",
      "exec curl -sS --fail-with-body --max-time 15 --unix-socket " + quote(socketPath)
        + " -H 'content-type: application/json'"
        + " -d " + quote(JSON.stringify(body || {}))
        + " " + quote("http://chip402.local" + path)
    ]
  }

  // Process is single-shot, so calls queue rather than clobbering one another.
  property var pending: []

  function post(path, body, okMessage) {
    pending.push({ path: path, body: body || {}, okMessage: okMessage || "" })
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

  function refresh() {
    if (!daemon.running) daemon.running = true
    post("/refresh", {}, "")
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

  function copy(text) {
    var value = String(text || "")
    if (value === "") return
    Quickshell.execDetached(["bash", "-c", "printf %s " + quote(value) + " | wl-copy"])
    actionStatus = "Copied"
    actionStatusTimer.restart()
  }

  function openUrl(url) {
    var value = String(url || "")
    if (value === "") return
    Quickshell.execDetached(["omarchy-launch-browser", value])
  }

  function openHashscan(row) {
    if (!row) return
    var url = row.hashscan || Model.hashscanTx(row.txId, hashscan)
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
    setupProcess.command = ["bash", "-lc", "exec node " + quote(pluginDir + "/bin/chip402") + " setup"]
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

  Timer {
    id: delayedState
    interval: 1500
    running: true
    onTriggered: root.stateFile.reload()
  }

  Process {
    id: daemon
    running: true
    command: ["bash", "-lc", "exec node " + root.quote(root.pluginDir + "/daemon/chip402d.mjs")]
    stdout: StdioCollector { waitForEnd: false }
    stderr: StdioCollector { waitForEnd: false }
    onRunningChanged: if (running) root.daemonUp = true
    onExited: function(code) {
      root.daemonUp = false
      if (code !== 0) restartDaemon.restart()
    }
  }

  Timer {
    id: restartDaemon
    interval: 2000
    repeat: false
    onTriggered: if (!daemon.running) daemon.running = true
  }

  Process {
    id: apiProcess
    property string okMessage: ""
    running: false
    command: []
    stdout: StdioCollector { id: apiOut; waitForEnd: true }
    stderr: StdioCollector { id: apiErr; waitForEnd: true }
    onExited: function(code) {
      root.busy = false
      if (code === 0) {
        root.lastError = ""
        if (okMessage !== "") {
          root.actionStatus = okMessage
          actionStatusTimer.restart()
        }
      } else {
        root.lastError = (apiOut.text || apiErr.text || "").trim() || ("Request failed (" + code + ")")
      }
      root.stateFile.reload()
      root.drain()
    }
  }

  Process {
    id: setupProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(code) {
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
