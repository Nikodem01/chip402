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
  property bool daemonUp: false
  property string accountId: ""
  property string evmAddress: ""
  property string merchantAccountId: ""
  property string balanceTinybars: "0"
  property string spentTodayTinybars: "0"
  property string dailyCapTinybars: "100000000"
  property string perRequestTinybars: "10000000"
  property var allowHosts: []
  property var ledger: []
  property string lastError: ""
  property string actionStatus: ""
  property bool busy: false

  readonly property int refreshIntervalSec: intSetting("refreshIntervalSec", 15, 5, 3600)
  readonly property bool active: configured && !paused
  readonly property string statusText: !configured ? "Needs funding" : (paused ? "Paused" : "Live")
  readonly property string pluginDir: pluginPath()

  property FileView stateFile: FileView {
    path: Quickshell.env("HOME") + "/.local/state/omarchy-allowance/state.json"
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
    accountId = String(parsed.accountId || "")
    evmAddress = String(parsed.evmAddress || "")
    merchantAccountId = String(parsed.merchantAccountId || "")
    balanceTinybars = String(parsed.balanceTinybars || "0")
    spentTodayTinybars = String(parsed.spentTodayTinybars || "0")
    dailyCapTinybars = String(parsed.dailyCapTinybars || "100000000")
    perRequestTinybars = String(parsed.perRequestTinybars || "10000000")
    allowHosts = parsed.allowHosts || []
    ledger = parsed.ledger || []
    if (parsed.lastError) lastError = String(parsed.lastError)
  }

  function quote(value) {
    return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
  }

  function post(path, body, okMessage) {
    if (busy) return
    busy = true
    var xhr = new XMLHttpRequest()
    xhr.open("POST", "http://127.0.0.1:4402" + path)
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.onreadystatechange = function() {
      if (xhr.readyState !== 4) return
      busy = false
      if (xhr.status >= 200 && xhr.status < 300) {
        lastError = ""
        if (okMessage) {
          actionStatus = okMessage
          actionStatusTimer.restart()
        }
        stateFile.reload()
      } else {
        lastError = xhr.responseText || ("Request failed (" + xhr.status + ")")
      }
    }
    xhr.send(JSON.stringify(body || {}))
  }

  function refresh() {
    var xhr = new XMLHttpRequest()
    xhr.open("POST", "http://127.0.0.1:4402/refresh")
    xhr.setRequestHeader("Content-Type", "application/json")
    xhr.onreadystatechange = function() {
      if (xhr.readyState === 4) stateFile.reload()
    }
    xhr.send("{}")
    if (!daemon.running) daemon.running = true
  }

  function pause() {
    paused = true
    post("/pause", { paused: true }, "Allowance paused")
  }

  function resume() {
    paused = false
    post("/pause", { paused: false }, "Agents can spend")
  }

  function toggle() {
    if (paused) resume()
    else pause()
  }

  function setDailyCap(hbar) {
    post("/caps", { dailyTinybars: Model.hbarToTiny(hbar) })
  }

  function setPerRequestCap(hbar) {
    post("/caps", { perRequestTinybars: Model.hbarToTiny(hbar) })
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
    var url = row.hashscan || Model.hashscanTx(row.txId)
    if (url !== "") openUrl(url)
  }

  function openAccount() {
    if (accountId !== "") openUrl(Model.hashscanAccount(accountId))
    else openUrl("https://portal.hedera.com/faucet")
  }

  function runSetup() {
    actionStatus = "Writing operator key…"
    actionStatusTimer.restart()
    setupProcess.running = false
    setupProcess.command = ["bash", "-lc", "exec node " + quote(pluginDir + "/bin/allowance") + " setup"]
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
    command: ["bash", "-lc", "exec node " + root.quote(root.pluginDir + "/daemon/allowanced.mjs")]
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
    id: setupProcess
    running: false
    command: []
    stdout: StdioCollector { waitForEnd: true }
    stderr: StdioCollector { waitForEnd: true }
    onExited: function(code) {
      if (code === 0) {
        root.actionStatus = "Key ready — fund the EVM address"
        root.refresh()
      } else {
        root.lastError = "Setup failed"
      }
      actionStatusTimer.restart()
    }
  }
}
