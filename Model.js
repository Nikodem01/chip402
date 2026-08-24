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

// The stored ts is UTC. Substringing the ISO text puts UTC o'clock next to a "today" counted
// in local days, which is how a payment made at 04:57 came to read as 19:27 in the panel.
function ledgerTime(row) {
  var at = new Date(String(row && row.ts ? row.ts : ""))
  if (isNaN(at.getTime())) return ""
  return pad(at.getHours()) + ":" + pad(at.getMinutes())
}

// The amount has its own right-aligned column now, so a reader can scan the money down the
// panel instead of hunting for it at a different x on every row.
function ledgerAmount(row) {
  if (!row || row.kind === "audit") return ""
  var micro = String(row.amountMicro || "0")
  if (micro === "" || micro === "0") return ""
  return formatUsd(micro)
}

// A settled payment is one line: the tick, the payee, the time and the amount already say
// everything. Only a row with something unusual about it earns a second line, which is also
// what gives that row more weight than the routine ones around it.
function ledgerNote(row) {
  if (!row) return ""
  if (row.kind === "audit") return String(row.detail || "")
  var bits = []
  var status = String(row.status || "")
  if (status === "denied") {
    // The short code label, not the prose reason: the reason only ever half-rendered here.
    // chip402 log prints it in full.
    bits.push(denialCodeLabel(row.code))
  } else if (status === "pending") {
    bits.push("in flight")
  }
  // Not a prompt and not a block: an unfamiliar payee is simply visible in the history
  // instead of indistinguishable from a routine one.
  if (row.firstSight) bits.push("new payee")
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

// How many payment rows fit above the LIMITS sliders without the panel needing a scroll.
var LEDGER_VISIBLE = 5
// How many denial reasons fit on one line before it starts eliding.
var DENIAL_REASONS_SHOWN = 1

// Local days, matching the daemon's todayStamp(). A panel that says "today" has to mean the
// user's today, not UTC's.
function dayStampOf(date) {
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
}

function dayStampFor(ts) {
  var at = new Date(String(ts || ""))
  if (isNaN(at.getTime())) return ""
  return dayStampOf(at)
}

function todayStampLocal(nowMs) {
  return dayStampOf(new Date(nowMs === undefined ? Date.now() : nowMs))
}

// The panel is a receipt book: only rows where money moved or is moving. Denials and audit
// rows are relocated, never dropped — they stay in state.json and in chip402 log.
function paymentRows(ledger) {
  var rows = Array.isArray(ledger) ? ledger : []
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || row.kind === "audit") continue
    var status = String(row.status || "")
    if (status === "settled" || status === "paid" || status === "pending") out.push(row)
  }
  return out
}

function visiblePayments(ledger, limit) {
  return paymentRows(ledger).slice(0, limit === undefined ? LEDGER_VISIBLE : limit)
}

function deniedToday(ledger, nowMs) {
  var rows = Array.isArray(ledger) ? ledger : []
  var today = todayStampLocal(nowMs)
  var out = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || row.kind === "audit") continue
    if (String(row.status || "") !== "denied") continue
    if (dayStampFor(row.ts) !== today) continue
    out.push(row)
  }
  return out
}

// A cap refusing a payment is chip402 working, so these read as descriptions rather than
// alarms, and the panel renders them dim. Codes come from daemon/lib/policy.mjs.
function denialCodeLabel(code) {
  var value = String(code || "")
  if (value === "host_denied") return "host not allowed"
  if (value === "insecure_host") return "not https"
  if (value === "daily_cap") return "over cap"
  if (value === "per_request_cap") return "over request cap"
  if (value === "insufficient_funds") return "low balance"
  if (value === "fee_payer_mismatch") return "wrong sponsor"
  if (value === "unsupported") return "no payable option"
  if (value === "paused") return "paused"
  if (value === "unconfigured") return "no account"
  // stale_balance, fee_payer_unknown and hollow_account all mean chip402 would not vouch for
  // the payment right now. The hold line above the ledger already names which one.
  if (value === "stale_balance" || value === "fee_payer_unknown" || value === "hollow_account") return "held"
  if (value === "") return "blocked"
  return value.replace(/_/g, " ")
}

function denialSummary(rows) {
  var list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return ""
  var order = []
  var counts = {}
  for (var i = 0; i < list.length; i++) {
    var label = denialCodeLabel(list[i] ? list[i].code : "")
    if (counts[label] === undefined) {
      counts[label] = 0
      order.push(label)
    }
    counts[label] += 1
  }
  // "not paid" rather than "blocked": the daemon files a seller that never answered under the
  // same status as a cap refusal, and only one of those is chip402 deciding something.
  var head = list.length + " not paid today"
  // One reason needs no breakdown: "2 not paid today · 2 over cap" says it twice.
  if (order.length === 1) return head + " · " + order[0]
  // Commonest first, and only two of them: the line has a 380px panel to fit in, and a
  // breakdown that elides mid-reason is worse than one that says how much it left out.
  order.sort(function(a, b) { return counts[b] - counts[a] })
  var parts = []
  for (var j = 0; j < order.length && j < DENIAL_REASONS_SHOWN; j++) {
    parts.push(counts[order[j]] + " " + order[j])
  }
  var rest = order.length - parts.length
  return head + " · " + parts.join(", ") + (rest > 0 ? " +" + rest + " more" : "")
}

// Raising a cap is the most privileged act in the system, so it stays visible — but beside
// the sliders that caused it, not interleaved with payments at the same weight.
function auditSummary(ledger, nowMs) {
  var rows = Array.isArray(ledger) ? ledger : []
  var today = todayStampLocal(nowMs)
  var count = 0
  var last = ""
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || row.kind !== "audit") continue
    if (dayStampFor(row.ts) !== today) continue
    count += 1
    if (last === "") last = ledgerTime(row)
  }
  if (count === 0) return ""
  var head = count === 1 ? "Changed once today" : "Changed " + count + "× today"
  return last === "" ? head : head + " · last " + last
}

// The footer count is what keeps the trimming honest: the panel says how much it is not
// showing and where the rest is.
function hiddenCount(ledger, shown) {
  var rows = Array.isArray(ledger) ? ledger : []
  var seen = Number(shown)
  if (!isFinite(seen) || seen < 0) seen = 0
  return Math.max(0, rows.length - seen)
}

function hiddenLabel(count) {
  var n = Number(count) || 0
  if (n <= 0) return ""
  return (n === 1 ? "1 older entry" : n + " older entries") + " · chip402 log"
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
  if (phase === "need_key") return "A local key with no passphrase. Anything running as you can read it, so the caps — not the key — bound what it can lose"
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
    ledgerNote: ledgerNote,
    ledgerTime: ledgerTime,
    ledgerAmount: ledgerAmount,
    ledgerStatusLabel: ledgerStatusLabel,
    ledgerVisible: LEDGER_VISIBLE,
    paymentRows: paymentRows,
    visiblePayments: visiblePayments,
    deniedToday: deniedToday,
    denialCodeLabel: denialCodeLabel,
    denialSummary: denialSummary,
    auditSummary: auditSummary,
    hiddenCount: hiddenCount,
    hiddenLabel: hiddenLabel,
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
