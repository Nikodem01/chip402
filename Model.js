function emptyState() {
  return {
    paused: false,
    configured: false,
    accountId: "",
    evmAddress: "",
    merchantAccountId: "",
    merchantEvmAddress: "",
    balanceMicro: "0",
    spentTodayMicro: "0",
    dailyCapMicro: "10000000",
    perRequestMicro: "1000000",
    associated: false,
    hollow: false,
    balanceAt: "",
    balanceFresh: false,
    maxFloatMicro: "0",
    pendingMicro: "0",
    feePayer: "",
    facilitatorError: "",
    floatWarning: "",
    allowHosts: ["127.0.0.1", "localhost"],
    // Driven by the daemon so a mainnet ledger row never links to the testnet explorer.
    hashscan: "",
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
    if (data.caps && data.caps.dailyMicro) next.dailyCapMicro = String(data.caps.dailyMicro)
    if (data.caps && data.caps.perRequestMicro) next.perRequestMicro = String(data.caps.perRequestMicro)
    if (data.dailyCapMicro) next.dailyCapMicro = String(data.dailyCapMicro)
    if (data.perRequestMicro) next.perRequestMicro = String(data.perRequestMicro)
    if (!Array.isArray(next.ledger)) next.ledger = []
    next.paused = data.paused === true
    next.configured = data.configured === true || String(next.accountId || "") !== ""
    next.hollow = data.hollow === true
    next.balanceFresh = balanceIsFresh(next.balanceAt)
    next.pendingMicro = pendingMicro(next.ledger)
    return next
  } catch (e) {
    return emptyState()
  }
}

function pad(n) {
  return n < 10 ? "0" + n : String(n)
}

// Matches BALANCE_MAX_AGE_MS in the daemon. A balance nobody could read is not a balance of
// zero, and the panel should not present it as one.
function balanceIsFresh(balanceAt, nowMs) {
  var at = Date.parse(String(balanceAt || ""))
  if (!isFinite(at)) return false
  var now = nowMs === undefined ? Date.now() : nowMs
  return now - at <= 120000
}

function pendingMicro(ledger) {
  var rows = Array.isArray(ledger) ? ledger : []
  var total = 0
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].status === "pending") total += Number(String(rows[i].amountMicro || "0")) || 0
  }
  return String(total)
}

function splitMicro(micro) {
  var s = String(micro || "0")
  var neg = s.charAt(0) === "-"
  if (neg) s = s.substring(1)
  if (!/^\d+$/.test(s)) return { neg: false, whole: "0", frac: "" }
  while (s.length < 7) s = "0" + s
  return {
    neg: neg,
    whole: s.substring(0, s.length - 6).replace(/^0+(?=\d)/, "") || "0",
    frac: s.substring(s.length - 6).replace(/0+$/, "")
  }
}

function formatUsd(micro) {
  var parts = splitMicro(micro)
  var frac = (parts.frac + "000000").substring(0, 6).replace(/0+$/, "")
  if (frac.length === 0) frac = "00"
  else if (frac.length === 1) frac += "0"
  return (parts.neg ? "-" : "") + parts.whole + "." + frac + " USDC"
}

function formatUsdShort(micro) {
  var parts = splitMicro(micro)
  var frac = (parts.frac + "00").substring(0, 2)
  return (parts.neg ? "-" : "") + parts.whole + "." + frac
}

function usdToMicro(usd) {
  var n = Number(usd)
  if (!isFinite(n) || n < 0) return "0"
  return String(Math.round(n * 1000000))
}

function microToNumber(micro) {
  var parts = splitMicro(micro)
  var n = Number(parts.whole) + (parts.frac ? Number("0." + parts.frac) : 0)
  return parts.neg ? -n : n
}

// No base means the daemon has not told us which network this is. Render no link at all
// rather than guess an explorer that could belong to the wrong network.
function hashscanBase(base) {
  return String(base || "").replace(/\/$/, "")
}

function hashscanTx(txId, base) {
  var id = String(txId || "")
  var root = hashscanBase(base)
  if (id === "" || root === "") return ""
  return root + "/transaction/" + encodeURIComponent(id)
}

function hashscanAccount(accountId, base) {
  var id = String(accountId || "")
  var root = hashscanBase(base)
  if (id === "" || root === "") return ""
  return root + "/account/" + encodeURIComponent(id)
}

function ledgerTitle(row) {
  if (!row) return "Payment"
  if (row.kind === "audit") return auditTitle(row)
  if (row.host) return row.host
  var url = String(row.url || "")
  return url.replace(/^https?:\/\//, "")
}

function auditTitle(row) {
  var action = String(row.action || "")
  if (action === "caps") return "Cap changed"
  if (action === "allow-host") return "Host allowed"
  if (action === "pause") return "Paused"
  if (action === "resume") return "Resumed"
  return "Setting changed"
}

function ledgerMeta(row) {
  if (!row) return ""
  var ts = String(row.ts || "")
  var time = ts.length >= 19 ? ts.substring(11, 19) : ts
  var bits = []
  if (time) bits.push(time)
  if (row.kind === "audit") {
    if (row.detail) bits.push(String(row.detail))
    return bits.join(" · ")
  }
  bits.push(formatUsd(row.amountMicro || "0"))
  var status = ledgerStatusLabel(row.status)
  if (status) bits.push(status)
  // Not a prompt and not a block: an unfamiliar payee is simply visible in the history
  // instead of indistinguishable from a routine one.
  if (row.firstSight) bits.push("new payee")
  if ((status === "blocked" || status === "in flight") && row.reason) bits.push(String(row.reason))
  return bits.join(" · ")
}

function ledgerGlyph(row) {
  var status = row ? String(row.status || "") : ""
  if (row && row.kind === "audit") return "󰒓"
  if (status === "settled" || status === "paid") return "󰄬"
  if (status === "denied") return "󰅙"
  if (status === "pending") return "󰔟"
  return "󰇚"
}

function dailyMarks() {
  return [0.5, 1, 2, 5, 10, 25, 50]
}

function requestMarks() {
  return [0.01, 0.05, 0.1, 0.25, 0.5, 1]
}

function nearestIndex(marks, micro) {
  var value = microToNumber(micro)
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

function remainingMicro(dailyMicro, spentMicro) {
  var daily = Number(String(dailyMicro || "0"))
  var spent = Number(String(spentMicro || "0"))
  if (!isFinite(daily)) daily = 0
  if (!isFinite(spent)) spent = 0
  return String(Math.max(0, Math.round(daily - spent)))
}

function spendRatio(dailyMicro, spentMicro) {
  var daily = Number(String(dailyMicro || "0"))
  if (!isFinite(daily) || daily <= 0) return 0
  var spent = Number(String(spentMicro || "0"))
  if (!isFinite(spent) || spent <= 0) return 0
  return Math.max(0, Math.min(1, spent / daily))
}

// key -> HBAR -> complete the hollow account -> associate USDC -> USDC.
// The hollow step is its own phase because an account with no key on record cannot pay:
// the facilitator looks the key up and rejects every payment. Without naming it, the panel
// just showed a stuck spinner.
function setupPhase(evmAddress, accountId, hollow, associated, balanceMicro) {
  if (String(evmAddress || "") === "") return "need_key"
  if (String(accountId || "") === "") return "need_hbar"
  if (hollow === true) return "completing"
  if (associated !== true) return "associating"
  var balance = Number(String(balanceMicro || "0"))
  if (!isFinite(balance) || balance <= 0) return "need_usdc"
  return "ready"
}

function setupSteps() {
  return [
    { phase: "need_key", label: "Create the operator key" },
    { phase: "need_hbar", label: "Send a little HBAR" },
    { phase: "completing", label: "Put the key on record" },
    { phase: "associating", label: "Associate USDC" },
    { phase: "need_usdc", label: "Top up USDC" }
  ]
}

function setupHint(phase) {
  if (phase === "need_key") return "chip402 needs an operator key before it can be funded"
  if (phase === "need_hbar") return "Send a little HBAR to the address below to create the account"
  if (phase === "completing") return "Writing the key on record — one cheap transaction, then payments can be signed"
  if (phase === "associating") return "Associating USDC so the account can hold it"
  if (phase === "need_usdc") return "Top up USDC from HashPack — keep the real balance there"
  return ""
}

function humanError(raw) {
  var text = String(raw || "").trim()
  if (text === "") return ""
  var lower = text.toLowerCase()
  if (lower.indexOf("paused") !== -1) return "chip402 is paused — flip the switch to let agents spend"
  if (lower.indexOf("unconfigured") !== -1 || lower.indexOf("no hedera account") !== -1) {
    return "No Hedera account yet — send a little HBAR to the address below"
  }
  if (lower.indexOf("host_denied") !== -1 || lower.indexOf("allowlist") !== -1) {
    return "That host is not allowed. Localhost is on by default; add others with chip402 allow"
  }
  if (lower.indexOf("per_request") !== -1 || lower.indexOf("per-request") !== -1) {
    return "Invoice is over the per-request cap"
  }
  if (lower.indexOf("daily") !== -1 && lower.indexOf("cap") !== -1) {
    return "This payment would go past today's cap"
  }
  if (lower.indexOf("stale_balance") !== -1 || lower.indexOf("could not be read recently") !== -1) {
    return "Cannot read the balance right now — payments are held until it can"
  }
  if (lower.indexOf("fee_payer_unknown") !== -1 || lower.indexOf("/supported discovery") !== -1) {
    return "Cannot reach the facilitator to confirm who sponsors payments — payments are held"
  }
  if (lower.indexOf("fee_payer_mismatch") !== -1) {
    return "That invoice names a different payment sponsor than the facilitator advertises"
  }
  if (lower.indexOf("hollow") !== -1) return "Putting the account key on record before it can pay"
  if (lower.indexOf("redirect") !== -1) return "The seller redirected the payment somewhere it is not allowed to go"
  if (lower.indexOf("insecure_host") !== -1 || lower.indexOf("cleartext") !== -1) {
    return "That host is http, not https — chip402 will not send a signed transfer in the clear"
  }
  if (lower.indexOf("insufficient") !== -1) return "Not enough USDC on the operator"
  if (lower.indexOf("association failed") !== -1 || lower.indexOf("associat") !== -1) {
    return "Need a little HBAR so this account can hold USDC"
  }
  if (lower.charAt(0) === "{" || lower.indexOf("<html") !== -1) return "Request failed — is the daemon running?"
  if (lower.indexOf("econnrefused") !== -1 || lower.indexOf("enoent") !== -1 || lower.indexOf("network error") !== -1) {
    return "Daemon is not reachable on its socket"
  }
  return text
}

function ledgerStatusLabel(status) {
  var value = String(status || "")
  if (value === "settled" || value === "paid") return "paid"
  if (value === "denied") return "blocked"
  if (value === "pending") return "in flight"
  if (value === "audit") return ""
  if (value === "") return ""
  return value
}

function markLabel(value) {
  if (value >= 0.01) return String(value) + " USDC"
  return String(value)
}

if (typeof module !== "undefined") {
  module.exports = {
    emptyState: emptyState,
    parseState: parseState,
    formatUsd: formatUsd,
    formatUsdShort: formatUsdShort,
    usdToMicro: usdToMicro,
    hashscanTx: hashscanTx,
    hashscanAccount: hashscanAccount,
    ledgerTitle: ledgerTitle,
    ledgerMeta: ledgerMeta,
    ledgerStatusLabel: ledgerStatusLabel,
    nearestIndex: nearestIndex,
    dailyMarks: dailyMarks,
    requestMarks: requestMarks,
    dailyCapMarks: dailyMarks,
    requestCapMarks: requestMarks,
    remainingMicro: remainingMicro,
    spendRatio: spendRatio,
    balanceIsFresh: balanceIsFresh,
    pendingMicro: pendingMicro,
    setupPhase: setupPhase,
    setupSteps: setupSteps,
    setupHint: setupHint,
    ledgerGlyph: ledgerGlyph,
    auditTitle: auditTitle,
    microToNumber: microToNumber,
    humanError: humanError
  }
}
