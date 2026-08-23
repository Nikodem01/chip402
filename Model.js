function emptyState() {
  return {
    paused: false,
    configured: false,
    accountId: "",
    evmAddress: "",
    merchantAccountId: "",
    merchantEvmAddress: "",
    balanceTinybars: "0",
    spentTodayTinybars: "0",
    dailyCapTinybars: "100000000",
    perRequestTinybars: "10000000",
    allowHosts: ["127.0.0.1", "localhost"],
    lastError: "",
    ledger: [],
    updatedAt: ""
  }
}

function parseState(raw) {
  var text = String(raw || "").trim()
  if (text === "") return emptyState()
  try {
    var data = JSON.parse(text)
    var next = emptyState()
    var key
    for (key in next) {
      if (data[key] !== undefined && data[key] !== null) next[key] = data[key]
    }
    if (data.caps && data.caps.dailyTinybars) next.dailyCapTinybars = String(data.caps.dailyTinybars)
    if (data.caps && data.caps.perRequestTinybars) next.perRequestTinybars = String(data.caps.perRequestTinybars)
    if (!Array.isArray(next.ledger)) next.ledger = []
    next.paused = data.paused === true
    next.configured = data.configured === true || String(next.accountId || "") !== ""
    return next
  } catch (e) {
    return emptyState()
  }
}

function pad(n) {
  return n < 10 ? "0" + n : String(n)
}

function splitTiny(tiny) {
  var s = String(tiny || "0")
  var neg = s.charAt(0) === "-"
  if (neg) s = s.substring(1)
  if (!/^\d+$/.test(s)) return { neg: false, whole: "0", frac: "" }
  while (s.length < 9) s = "0" + s
  return {
    neg: neg,
    whole: s.substring(0, s.length - 8).replace(/^0+(?=\d)/, "") || "0",
    frac: s.substring(s.length - 8).replace(/0+$/, "")
  }
}

function formatHbar(tiny) {
  var parts = splitTiny(tiny)
  var out = parts.frac ? parts.whole + "." + parts.frac : parts.whole
  return (parts.neg ? "-" : "") + out + " ℏ"
}

function formatHbarShort(tiny) {
  var parts = splitTiny(tiny)
  var frac = parts.frac
  if (frac.length > 3) frac = frac.substring(0, 3).replace(/0+$/, "")
  var out = frac ? parts.whole + "." + frac : parts.whole
  return (parts.neg ? "-" : "") + out
}

function hbarToTiny(hbar) {
  var n = Number(hbar)
  if (!isFinite(n) || n < 0) return "0"
  return String(Math.round(n * 100000000))
}

function tinyToNumber(tiny) {
  var parts = splitTiny(tiny)
  var n = Number(parts.whole) + (parts.frac ? Number("0." + parts.frac) : 0)
  return parts.neg ? -n : n
}

function hashscanTx(txId) {
  var id = String(txId || "")
  if (id === "") return ""
  return "https://hashscan.io/testnet/transaction/" + encodeURIComponent(id)
}

function hashscanAccount(accountId) {
  var id = String(accountId || "")
  if (id === "") return ""
  return "https://hashscan.io/testnet/account/" + encodeURIComponent(id)
}

function ledgerTitle(row) {
  if (!row) return "Payment"
  if (row.host) return row.host
  var url = String(row.url || "")
  return url.replace(/^https?:\/\//, "")
}

function ledgerMeta(row) {
  if (!row) return ""
  var amount = formatHbar(row.amountTinybars || "0")
  var status = String(row.status || "")
  var ts = String(row.ts || "")
  var time = ts.length >= 19 ? ts.substring(11, 19) : ts
  return time + " · " + amount + " · " + status
}

function ledgerGlyph(row) {
  var status = row ? String(row.status || "") : ""
  if (status === "settled" || status === "paid") return "󰄬"
  if (status === "denied") return "󰅙"
  return "󰇚"
}

function dailyMarks() {
  return [0.01, 0.1, 0.5, 1, 2, 5, 10]
}

function requestMarks() {
  return [0.00001, 0.0001, 0.001, 0.01, 0.1, 1]
}

function nearestIndex(marks, tiny) {
  var value = tinyToNumber(tiny)
  var best = 0
  var bestDist = Math.abs(marks[0] - value)
  for (var i = 1; i < marks.length; i++) {
    var dist = Math.abs(marks[i] - value)
    if (dist < bestDist) {
      best = i
      bestDist = dist
    }
  }
  return best
}

function markLabel(value) {
  if (value >= 0.01) return String(value) + " ℏ"
  return String(value)
}

if (typeof module !== "undefined") {
  module.exports = {
    emptyState: emptyState,
    parseState: parseState,
    formatHbar: formatHbar,
    formatHbarShort: formatHbarShort,
    hbarToTiny: hbarToTiny,
    hashscanTx: hashscanTx,
    hashscanAccount: hashscanAccount,
    ledgerTitle: ledgerTitle,
    ledgerMeta: ledgerMeta,
    nearestIndex: nearestIndex,
    dailyMarks: dailyMarks,
    requestMarks: requestMarks,
    dailyCapMarks: dailyMarks,
    requestCapMarks: requestMarks
  }
}
