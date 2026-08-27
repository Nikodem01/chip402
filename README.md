# chip402 — agentic pocket money

An agent has a small purse it can spend from without asking, and I can watch it and stop it.

That is the whole idea. chip402 is an Omarchy bar widget plus a small daemon that holds a
hard-capped Hedera wallet. A local AI agent gets one MCP tool — `pay(url)` — and can buy
anything behind an [x402](https://x402.org) paywall it finds, with no allowlist, no per-seller
setup and no prompt for any individual payment. I get a live view of what it spent and a big red
button. The agent never sees the key, never learns what x402 is, and can never spend more than
the day's allowance.

It is a prototype, on `hedera:testnet` by default. Mainnet is written and works; arming it is
one config value and a restart.

```
  ── uid 1000: me and my agents ──┊── uid chip402 ─────────────────────────────

  agent ──MCP stdio──┐            ┊
  human ──chip402────┼─spend.sock─┊─> chip402d ──HTTPS──> seller ─> facilitator ─> Hedera
  panel ─────────────┘  0660 grp  ┊   (key, policy —
    pay · purse · pause           ┊    no ledger)  <──HTTPS── mirror node (read-only)
                                  ┊
  root ──chip402ctl───admin.sock──┊─> same daemon, privileged verbs
    resume · allowance/max <asset>     0600 — uid 1000 cannot connect
       ↑ sudo or polkit, password every time
                                  ┊  key: TPM2-sealed credential → ro tmpfs, root + ACL
```

## The security model, stated plainly

**Two planes, and the plane is whichever socket accepted you.** Spending is a capability granted
to anything running as me — my shells, my agents, the panel. Changing what that capability
permits costs a password. There is no token, no signature and no auth code anywhere in the
protocol: the daemon binds two listeners and each one has a fixed verb set.

|  | Spend plane | Control plane |
|---|---|---|
| Socket | `/run/chip402/spend.sock` — `0660 chip402:chip402` | `/run/chip402/admin.sock` — `0600 chip402:chip402` |
| Who reaches it | anything in group `chip402` | **root only** |
| Verbs | `pay`, `purse`, **`pause`** | `resume`, `allowance <asset>`, `max <asset>` |

**Anyone can hit the big red button. Only a human with a password restarts the line.** An agent
that pauses the purse has denied only itself; an agent that could resume it would be the whole
attack. So pause is free and resume is not, and the asymmetry shows up in the panel as a
different button rather than as an explanation printed at the user.

**Three separate mechanisms force the caps**, and all three are needed:

1. **The agent cannot sign.** It has no key, so the only way money moves is `pay` on the spend
   socket. That makes the daemon a chokepoint rather than one option among several.
2. **The check is inside the only function that touches the key.** `src/wallet.ts` wraps the
   Hedera signer in one of its own whose `createPartiallySignedTransferTransaction` runs
   `policy.decide` first and throws on deny. One door, and the check is on the same side of it
   as the key. This is deliberately *not* the SDK's `onBeforePaymentCreation` hook — a hook is a
   convention that a direct call to the scheme walks past, and chip402 registers no hook at all.
   What it does register is `spendControls` and a scheme table with only v2 in it: an independent
   second opinion by a different implementation, running before our guard rather than instead of
   it. `src/wallet.ts` translates its three refusals into the same vocabulary `policy.ts` uses, so
   the agent gets a reason and not a paragraph about SDK configuration.
3. **The limits cannot be moved, and the spending cannot be edited because it is not written
   down.** `/var/lib/chip402/purse.json` is `chip402:chip402 0600` and holds policy and nothing
   else: the two limits per asset, and `paused`. Every verb that **raises** anything — both limits,
   in both assets, and `resume` — lives on the admin socket; the one spend-plane verb that writes
   this file is `pause`, which can only ever take capability away. Missing file → start paused with
   a zero allowance; unparseable → refuse to start. What has been spent today is not in that file,
   or in any file — the other three things `/var/lib/chip402` holds are host names, a settling lock
   and the TPM2-sealed key, and none of them is a number. See the next section.

**What is *not* prevented, stated sharply.** The agent chooses the URL, so it can point at a
seller it controls and dictate the whole invoice. That is bounded rather than prevented, and
bounding it is the right answer — see *Why there is no seller allowlist*. Hedera `exact` signs a
one-shot transfer of an exact amount, with no approval and no delegation, so a fully malicious
seller extracts at most `maxPayment` per call and at most the remaining daily allowance in total.
The honest number: **a fully hostile agent drains the daily allowance, every day, and nothing
more.** If that is too much, the allowance is the dial.

**And the ceiling.** Passwordless sudo, or anything that can read my keystrokes, defeats the
control plane — but that already owns the whole machine, not just the purse. polkit cannot be
*forged* (polkitd performs the authentication; an unprivileged agent only relays it), but a fake
dialog at a plausible moment can still get me to type a password. That is why the two boundaries
here are different in kind: **key custody is mechanical** and needs no judgment from me, so it
cannot be tricked; **raising a cap is human**, so it can fail. The small purse is what bounds the
damage when the human-judgment boundary fails, and even a successful phish only buys a resume —
raising a cap needs a second one.

## chip402 stores policy, not facts

**Policy is ours and can come from nowhere else: the two limits per asset, `paused`, and where
local midnight falls. Facts live on the chain: the balance, what has been spent, who was paid,
and whether a payment happened at all.** The daemon shows those; it never keeps a second copy and
then reconciles the two.

The rule is not "keep nothing locally", and it is worth being exact about that, because chip402
*does* keep two things, and neither is a number the chain owns.

**A `txId → host` map**, so a row can read `printwright.liftbyai.com` instead of `0.0.9584959`.
Two properties make that legitimate where a local spend counter was not:

- **The chain does not know it and cannot.** There is no second copy to drift from, because there
  is no first copy anywhere else. The counter was a duplicate of something Hedera already
  answered; a hostname is not.
- **It cannot reach a decision.** `hostFor` is called by the snapshot and by nothing else. No
  limit, no sum, no policy path touches it. Lose the whole map and the worst outcome is rows that
  name account ids.

**A settling lock** — one transaction id and the instant it stops being able to reach consensus.
Same two tests, differently: the id is what *we authorised*, which the chain cannot tell us and
which nothing else has a copy of; and it reaches a decision only in one direction, by denying.
It carries no amount and no claim that anything happened, so there is nothing in it to reconcile
and nothing in it that can raise a limit or make a payment look paid. Losing it costs at most two
minutes of denial. It is on disk rather than in memory because the daemon that has to honour it
may not be the one that took it — see *the indexing gap*, below.

So the two rules that actually survive are: *never keep a local copy of a number the chain owns*,
and *never let local state reach a decision except by refusing*. Neither of these breaks either.

### Three files, because they want three different things when they break

Those names lived inside `purse.json` at first, and that was a defect regardless of how small the
file was — one this project's own thesis should have caught sooner. So did the settling lock,
except that it lived nowhere at all. Everything chip402 keeps on disk now has a file whose failure
mode is the one that thing actually wants:

| | `purse.json` — policy | `labels.jsonl` — host names | `settling.json` — the lock |
|---|---|---|---|
| size | ~250 bytes, fixed | grows with every payment | ~90 bytes, or absent |
| written by | root over the admin socket to raise anything; anyone over the spend socket to `pause` | the daemon, on every payment | the daemon, before each signature |
| **if it cannot be read** | **refuse to start** — "I do not know the limits" must never become "there are no limits" | **carry on with fewer names.** Losing all of them costs nothing | **assume it is held** — for as long as any real lock could last, a little over two minutes |

Sharing a file meant sharing a failure mode, and the shared one had to be the strict one. So a
growing pile of decoration could push the file past the size the daemon agrees to read — and then
the daemon would refuse to **start**, on some later boot, over host names. A display nicety must
never be able to stop a payment daemon. That is the same shape of bug as a check that gates
nothing, pointed the other way: something inert reaching something critical.

Apart, each file gets what it actually wants. `purse.json` is four numbers and a flag with a hard
cap three hundred times what it needs, and an unreadable one still stops everything. `labels.jsonl`
is append-only — one short line at the end of a file per payment, rather than an atomic rewrite of
the limits — and **nothing about it can stop the daemon**: truncated, corrupt, half-written, too
big to read whole, a directory where the file should be, and a write it cannot make at all are
survivable, and each costs names and only names. The last of those is the one that had to be
fixed rather than asserted: both writers sit where a throw is expensive — the seed write runs
before the daemon binds a socket, and the append runs *after* a signature — so every write in
`labels.ts` swallows its own failure. `test/labels.test.ts` asserts every one of those, with the contrasting
`purse.json` case sitting next to them so the difference is visible in one place.

`settling.json` is the third answer and the only one where damage has to read as *more* caution,
not less: an unreadable lock is honoured rather than ignored, because "assume nothing is in flight"
is the reading that authorises a second payment. A recorded deadline is never honoured for longer
than a real one could have run, so a garbled number costs a bounded stretch of denial and cannot
wedge the purse.
It is also the reason the lock is not simply a key inside `purse.json`: that file already has two
writers — root raising a limit, and anyone pressing PAUSE — and the lock would be a third, written
on the payment path, which is exactly when the other two are most likely to arrive. Two atomic
rewrites of one whole file a millisecond apart is a lost update.

The split also removes the label ceiling. Names are no longer capped to fit inside somebody else's
size limit; the file is capped at 100,000 — twenty payments a day for thirteen years — and past
that it is read from the end and compacted, losing the oldest rather than refusing.

This is not tidiness. The previous build kept its own `spentToday` counters and its own receipt
list, and that ledger was **already wrong** — with no attacker involved:

| | `purse.json` said | the chain said |
|---|---|---|
| USDC spent today | $1.62 | $1.62 ✓ |
| HBAR spent today | ℏ0.02 | **ℏ0.00** ✗ |

Two HBAR payments made by a previous wallet, `0.0.10228269`, had survived a `setup --import` and
were charging the new account's allowance for money it never spent. A hand-written ledger drifts
from reality on its own. `test/chain.test.ts` pins that exact regression against a verbatim
capture of the mirror node's answer: seen from the new account those two transactions are money
*arriving*, and seen from the old one they are exactly the missing ℏ0.02.

**How a payment is identified**, verified against real data rather than assumed. An x402 payment
is a transaction where all three hold at once:

- `result === "SUCCESS"`, so a failure costs the allowance nothing; and
- the transaction id's payer is **not us** — the facilitator sponsors every x402 payment, so
  anything the owner initiated is excluded on this line alone; and
- our account has a **negative** entry for that asset, so money arriving is not money spent.

Today's spend is that filter summed since local midnight. The receipt list is the same query, so
every row is a transaction that provably happened and every HashScan link provably resolves.

**The indexing gap is closed by waiting, not by counting.** The mirror node is a couple of
seconds behind consensus, so a payment is not finished until the chain shows it. The daemon shuts
the lane on its way to the key — before anything is signed — and reopens it only when the id it
then reads out of the bytes it signed appears on the mirror, or when the clock proves it never
will. That instant is **not** `validStart + 120 s`, and the difference is load-bearing: 120 seconds
is Hedera's `TransactionValidDuration`, the last moment the *chain* would accept the transaction,
while the lane needs the last moment the *mirror node* could start showing one that was accepted at
the very end of that window. So the lock is held for the validity window plus the longest the
mirror is allowed to be behind consensus (`src/chain.ts`'s `INDEXING_MARGIN_MS`, twenty seconds —
the same patience a payment already spends waiting). Too long costs a payment refused for twenty
extra seconds; too short is a payment made twice. A payment attempted in that
window is denied with *a payment is still settling*. **Nothing is ever given back, because nothing
is ever taken, and nothing is ever counted twice, because we never count**: a payment that never
settles simply never appears in the sum. There is no reserve, no commit, no refund and no in-flight
amount tracker, because there is no local copy for any of them to reconcile against.

**And the lane survives a restart**, which it did not until it was demonstrated not to. The lock
used to live only in memory, so a daemon that went down between the signature and the mirror node
catching up came back with the lane open, read a ledger that did not yet contain the payment in
flight, and authorised a second one against it — one extra payment of up to `maxPayment`, for
anyone who could restart the unit inside the indexing window. `systemctl restart chip402` is
enough, on a cached polkit authorization (see below), and `Restart=on-failure` does it unattended.
So the two fields that make the lane a lane — the transaction id and its deadline — are written to
`settling.json` **before the key is reached**, which is also what makes a disk that cannot be
written a refusal to pay rather than a payment that has already been signed failing afterwards.
`test/daemon.test.ts` runs the whole attack: pay, deny, restart, and the third payment must still
be refused with the chain still showing exactly one transaction.

**What this costs, stated plainly rather than papered over:**

- **The mirror node is now load-bearing for spending as well as balance.** It was already trusted
  for the balance; a mirror that under-reported our own transfers could let the purse exceed its
  allowance, up to the real balance. That is the honest ceiling of this design.
- **Unreachable mirror ⇒ cannot compute spend ⇒ deny.** Same fail-closed posture the stale-balance
  check already had.
- **One extra pair of mirror queries per payment**, plus pagination when a day runs long. Past a
  bounded number of pages (12 × 100) the daemon cannot say what was spent and refuses to pay. That
  bound is about the pathological case, and it used to be cheap for somebody else to reach: every
  transaction the account so much as *appears in* counted against it, including money arriving, so
  1,200 dust transfers *in* — free on testnet, about $0.12/day on mainnet — stopped payment until
  local midnight. The fix is not more pages. When the wide query overflows, the daemon asks the
  narrower one the sum was only ever going to keep — the transactions that took money **out** —
  and dust weighs nothing there, because every debit of this account needs a signature only this
  daemon can produce. If that overflows too, the refusal stands: fail-closed is postponed, never
  weakened.
- **A few seconds of latency at the tail of each payment**, waiting for the chain to catch up.

## Five limits

| Limit | Bounds | Changed by |
|---|---|---|
| Per-payment cap, per asset | one bad invoice | control plane. Enforced by `policy.decide` **and** independently by the SDK's `spendControls` |
| Daily allowance, per asset | a runaway loop, and every hostile seller combined | control plane. Measured against what the chain says went out since local midnight; `0` switches the asset off |
| Purse balance | total exposure, ever | **nobody** — it is the on-chain fact, read from the mirror node |
| Asset + network pin | chain and token confusion | the `src/networks.ts` row. Another chain or token is refused, never converted |
| Pause | everything, instantly | **pause: anyone. resume: control plane** |

## Two assets, and why there is no price feed

USDC and HBAR, each with its own budget in its own unit — micro-USDC (6 decimals) and tinybars
(8). **chip402 never converts between them, so it never needs to know a price.** A `$2.00/day`
allowance cannot be enforced against HBAR without an oracle, and an oracle is a new trust
dependency with a staleness failure sitting in the deny path. Two budgets cost nothing and
remove the problem:

```
usdc:  allowance $2.00/day     maxPayment $0.25
hbar:  allowance 100 HBAR/day  maxPayment 10 HBAR
```

The toggle falls out for free — a zero allowance switches an asset off, so there is no separate
enable flag that could disagree with the number. When a seller offers both, USDC wins: it is the
stable one, so a receipt means the same thing tomorrow as it did today.

## What a hostile seller tried

The x402 v2 spec's §10 covers replay only, is EVM-specific, and calls budget management
"implementation-specific" — the buyer side is ours. The first three below come from reading
`wrapFetchWithPayment` rather than the spec, and each has a row in `test/seller.test.ts`.

| Attack | Answer |
|---|---|
| **Redirect laundering.** The wrapper follows redirects and then policies against `response.url`. `harmless.example` → 302 → `evil.example` serves the 402. | Our fetch is `redirect: "manual"` and refuses a cross-origin redirect; policy runs against the URL that actually answered. |
| **Unbounded 402 body.** The wrapper does `await response.text()` with no cap and no deadline, before any policy runs. | Our own fetch is handed to the SDK: byte cap, `AbortSignal.timeout`, and a cap on `accepts[]`. `globalThis.fetch` is never given to it. |
| **Lying settlement header.** `PAYMENT-RESPONSE` is written by the seller. | **It is not read at all**, anywhere in `src/`. It used to supply the transaction id on a receipt; the id in the bytes we signed is the same id and is not the seller's to write, so the whole class is gone. `test/signer.test.ts` asserts it stays gone. |
| **Taking a signature and never settling** — the seller keeps the signed transfer and never submits it, hoping to burn the daily cap. | Costs nothing. The allowance is measured from what the chain shows, so an unsettled payment never enters the sum; the lane reopens on its own once the transaction can no longer reach consensus. |
| **Naming us as the recipient.** `payTo` set to our own account: the transfer nets to zero, the content is delivered, the allowance is consumed. | `deny("seller named us as the recipient")`, alongside the same check on `feePayer`. |
| **Asking for a second signature in one call.** A signed `exact` transfer is a bearer instrument; two is twice the money. The SDK's `recovered` path can build a second payload. | A `signed` flag in the per-payment closure. The second call throws before the key is reached — stated rather than inherited from "we register no hook". |
| **Version downgrade** to a v1 body. | Only `x402Version === 2` is accepted, and the scheme is registered for v2 only. |
| **Fee-payer abuse** — `extra.feePayer` naming our own account, so we pay the network fee. | Must be a valid entity id and must not be us. |
| **Asset or chain substitution.** | Pinned to the `networks.ts` row; `spendControls.allowedAssets` re-checks independently. |
| **Prompt injection through the paid body**, including *forging the trust boundary* — the fence used to be a fixed literal wrapped around the body in one block, so a seller could write the closing line and append instructions that read as ours. | The seller's bytes go in a **content block of their own**, with none of our framing inside it to close, and the markers on either side carry a **nonce drawn fresh per call** that nothing which has never seen it can write. `test/mcp.test.ts` drives a seller that tries. The containment that matters is still elsewhere: a manipulated agent cannot exceed the allowance. |
| **Replay of our signed transfer.** | Nothing to build — Hedera rejects a duplicate transaction id at consensus, and the validity window is short. This is *why* charge-at-signature is right. |
| **Malicious facilitator** (chosen by the seller). | It cannot alter a signed transfer without failing signature checks, and refusing to settle costs us nothing — see *The facilitator is the seller's, not ours*, below, where one of them stopped settling mid-review and cost exactly that. |

### The facilitator is the seller's, not ours

The facilitator is the party that adds the fee-payer signature and submits the transfer to Hedera.
**The seller picks it, chip402 never sees the choice, and nothing about the design rests on which
one it is.** That is not an oversight to tidy up later; it is why the daemon reads the mirror node
instead of the `PAYMENT-RESPONSE` header the facilitator's answer arrives in. A facilitator can lie
about settling, or simply stop, and the purse's figures do not move either way — because they are
not the purse's figures.

That got tested for real rather than argued. There is **no facilitator operated by Hedera**; two
advertise `hedera:testnet`:

| | operator | fee payer | |
|---|---|---|---|
| `https://api.testnet.blocky402.com` | [Blocky402](https://blocky402.com), by BlockyDevs — independent, open source, and the one [Hedera's own x402 announcement](https://hedera.com/blog/hedera-and-the-x402-payment-standard/) points at | `0.0.7162784` | what `demo/seller.ts` uses |
| `https://x402.org/facilitator` | the x402 protocol's own reference facilitator | `0.0.9185802` | what it used to use |

The second one **stopped settling** while this was being written: it still advertises
`hedera:testnet`, still verifies a payment, and then returns an unsuccessful settlement with no
reason — its account submitted nothing to Hedera for the better part of a day. chip402's behaviour
under that is the whole argument in one run: the daemon signed once, the receipt said
`onChain: false` because the mirror node never showed the transaction, the day's spending did not
move, and the lane reopened on the clock. Nothing had to be reconciled, because nothing had been
written down. `test/live.test.ts` now tells that apart from a defect — a transaction still absent
past its validity window was never submitted — and fails naming the facilitator rather than a
missing word in a body.

`demo/seller.ts --facilitator https://…` (or `CHIP402_FACILITATOR`) points it anywhere. It is the
seller's flag, and the seller is not part of chip402.

### Why there is no seller allowlist

An allowlist assumes I know the shops in advance, but the premise is an agent finding a paywall
it has never seen. The list would be empty — the agent can buy nothing — or maintained by hand
all day, which is worse than paying myself. It also buys nothing: the loss it defends against is
already bounded by `maxPayment` per call and `allowance` per day **no matter who the seller is**.
Two hundred unknown sellers at a cent each costs exactly what one known seller at $2.00 costs.
The amount is the only term that matters, so every limit here is amount-based.

Two cheap things survive from that space: **no plaintext payments** (an `http:` seller on a
public host can be impersonated by anyone on the network path, so it is refused; loopback is
allowed, which is how the demo seller works), and **every payment row names its counterparty** —
the host we actually reached, or the account id the chain has if we never labelled it, so a name
you do not recognise is visible at a glance. Visibility, not a gate.

## Key custody

The realistic threat is not a stolen laptop. It is an agent running as me that greps `~/.config`,
finds a key, and pastes it into a transcript. Only a different uid actually stops that.

- The daemon runs as a dedicated system user `chip402`, as a system unit.
- The key is a TPM2-sealed systemd credential (`LoadCredentialEncrypted=`). On disk it is
  ciphertext sealed to this machine; at runtime systemd decrypts it into
  `/run/credentials/chip402.service/` — **a read-only tmpfs, so plaintext never touches disk.**
  Measured on the running unit rather than assumed: `findmnt` reports
  `tmpfs ro,nosuid,nodev,noexec,nosymfollow,size=1024k,mode=700`, and `getfacl` reports it
  **owned by root** with POSIX bits `dr-x------` plus an ACL entry `user:chip402:r-x`. (`ls -ld`
  renders that as `dr-xr-x---+`: the group field of a file with an ACL shows the mask. That is
  exactly why `readSecret` checks `mode & 0o007` and not `mode & 0o077` — see `src/safe.ts`.)
  uid 1000 cannot open the directory.
- The key never enters my home directory. `sudo chip402ctl setup` generates it, pipes it straight
  into `systemd-creds encrypt`, and never puts it in argv, an environment variable, or a file I own.

| An agent tries | Result |
|---|---|
| `grep -r` my home | nothing — no key there |
| read `/var/lib/chip402/key.cred` | denied; and TPM2-sealed, useless off this machine |
| read `/run/credentials/chip402.service/` | denied — different uid |
| attach to the daemon's memory | denied — different uid |
| talk to the spend socket | **succeeds, within the caps** — that is the product |

The uid boundary and the socket split only work together. uid alone: the agent must ask the
daemon to sign, but if it can raise its own limits, asking is enough. Socket split alone: the
agent cannot change the limits, but if it can read the key it never talks to the daemon at all.

## Install

Needs Node 26.7+ (for `--permission` and running `.ts` with no build step), Omarchy with its
polkit agent plugin, `qrencode`, and a TPM.

```bash
npm ci --ignore-scripts && npm run typecheck && npm test
sudo ./install.sh              # user, unit, chip402ctl, sudoers, polkit, panel; then re-login
sudo chip402ctl setup          # generate a key locally, fund the address, complete the account
sudo systemctl start chip402
omarchy plugin enable chip402 && omarchy restart shell
```

`install.sh` does not copy whatever `node_modules` happens to be lying in the checkout. It runs
`npm ci --ignore-scripts --omit=dev` itself, from the **committed `package-lock.json`**, into a
directory of its own, and installs that — so what the daemon runs is what was reviewed, at exact
versions, with no package having been allowed to run a lifecycle script. The `npm ci` above is
only so the tests have their dev dependencies.

`setup` generates an ECDSA key **on this machine and never transmits it**, seals it to the TPM,
prints the EVM address as a QR, waits for you to fund it, and then submits **the one and only
transaction this project ever sends** — the hollow-account completion, which is what puts the key
on record so the facilitator will accept payments.

### Already have an account?

```bash
sudo chip402ctl setup --import              # discovers the account from the key
sudo chip402ctl setup --import 0.0.12345    # or name it, and it is verified against the key
sudo chip402ctl setup --import < key.txt    # scripted
```

Most people trying this already have a testnet account with a few dollars in it from something
else, and making them fund a fresh one first is a pointless errand. `--import` takes the key you
already have, seals it to the TPM, and reads the account back off the mirror node — you do not
have to remember the id. What it does with it:

- **Nothing is echoed.** The key is read with the terminal's echo off, or straight off a pipe. A
  private key must never end up in scrollback.
- **DER hex or a raw ECDSA/ED25519 key** are all accepted, because wallets disagree about which
  one they hand you.
- **The key is checked against the account**, by public key on record or by EVM-address alias.
  Importing a key that does not control the account you named would otherwise produce a purse
  that looks perfectly healthy and cannot pay for anything.
- **A hollow account is completed** on the way through, same as a fresh one.
- **It tells you what is in there**, so you know what the agent is about to be handed.

One thing to be clear about: sealing is to *this* TPM. `setup` pipes the key into
`systemd-creds encrypt --name=chip402-key --with-key=host+tpm2`, and `host+tpm2` is what makes the
ciphertext useless elsewhere: it is bound both to the machine's own secret and to the TPM, so
neither a copied file nor a copied disk opens it on another machine. That is a property of
`systemd-creds` rather than of anything in this tree, so it is cited and not claimed as measured —
what is checked here is which key type is asked for (`bin/chip402ctl.ts`) and that this machine has
a TPM to ask (`systemd-analyze has-tpm2` → `yes`). There is no backup and no recovery: if the
machine goes, so does the key. That is the right trade for pocket money and the wrong one for
anything else, which is the same reason the purse is small.

Fund testnet HBAR at [portal.hedera.com/faucet](https://portal.hedera.com/faucet) — paste the
`0x…` address. After completion the account has unlimited auto-association, so testnet USDC
(`0.0.429274`) arrives with no association step. On mainnet the same address is funded from an
exchange or a wallet; nothing in the flow changes.

The purse deliberately starts **paused with a zero allowance**. Open the panel, press RESUME, and
tap an allowance — two password prompts, and that is the last time you need either.

### Point an agent at it

```json
{ "mcpServers": { "chip402": { "command": "node", "args": ["/home/you/chip402/bin/mcp.ts"] } } }
```

Two tools, `pay(url)` and `purse()`. Nothing else, and nothing that can raise a limit.

### Mainnet

Edit `/etc/chip402/config.json` — `"network": "hedera:mainnet"` — and restart. That row in
`src/networks.ts` carries the mirror node, the mainnet USDC token id and the HashScan base; there
is no `if (mainnet)` anywhere else in the code. The panel turns its accent colour and prints
`MAINNET` on the bar.

## Play the agent

Every one of these must fail, as me, with no password. `nc -U` works if you have it; the examples
use `socat`, which Omarchy ships.

```bash
# raise my own allowance, three ways
echo '{"cmd":"allowance","asset":"usdc","amount":"1000.00"}' | socat - UNIX-CONNECT:/run/chip402/spend.sock
                                                                 # refused: unknown verb
echo '{"cmd":"resume","plane":"admin"}' | socat - UNIX-CONNECT:/run/chip402/spend.sock
                                                                 # refused: the plane is the listener
socat - UNIX-CONNECT:/run/chip402/admin.sock                     # denied: 0600, wrong uid
echo '{}' > /var/lib/chip402/purse.json                          # denied: chip402:chip402 0600
# and there is nothing worth editing in there anyway — what has been spent today is not a number
# this machine keeps. It is a query against the Hedera mirror node, made fresh before every
# payment. See "chip402 stores policy, not facts".

# undo the kill switch
echo '{"cmd":"resume"}' | socat - UNIX-CONNECT:/run/chip402/spend.sock   # refused: admin verb
chip402ctl resume                                                # refused: geteuid() != 0
sudo chip402ctl resume                                           # PROMPTS — every time, never cached
pkexec /usr/local/bin/chip402ctl resume                          # PROMPTS — the agent cannot answer it

# get the key instead
cat /var/lib/chip402/key.cred                                    # denied (and TPM2-sealed anyway)
cat /run/credentials/chip402.service/chip402-key                 # denied
cat /proc/$(pgrep -f /usr/local/lib/chip402)/mem                 # denied — different uid
grep -rl "302e0201" ~/.config ~/.local/state                     # nothing: no key anywhere I own

# take the daemon out to force a fallback
pkill -f /usr/local/lib/chip402                                  # denied: different uid
rm /run/chip402/spend.sock                                       # denied: dir is 0750, no group write
systemctl stop chip402                                           # see below — this one can succeed

# rewrite the thing sudo runs
echo 'pwn' >> /usr/local/bin/chip402ctl                          # denied: root:root 0755

# be the seller: dictate the invoice from a host I control
node demo/seller.ts --pay-to 0.0.5005 --price 999.00 &
./bin/chip402.ts pay http://127.0.0.1:4403/secret                # denied: over maxPayment
for i in $(seq 300); do ./bin/chip402.ts pay http://127.0.0.1:4403/secret; done
                                                                 # stops at the allowance — and
                                                                 # the number that stops it is on
                                                                 # HashScan, not in a file here
./bin/chip402.ts pay http://192.168.1.9:4403/secret              # denied: plaintext, not loopback
ss -ltnp | grep -c chip402                                       # 0 — no TCP port anywhere
```

**One of those is not a denial, and the README would be lying if it claimed otherwise.**
`systemctl stop chip402` is guarded by polkit's `org.freedesktop.systemd1.manage-units`, which
ships as `auth_admin_keep` for an active session — so it needs admin authentication, but a
*cached* authorization from any earlier privileged action in the same session satisfies it
silently. Read out of polkit's own database rather than by stopping a daemon that holds money:

```
$ pkaction --action-id org.freedesktop.systemd1.manage-units --verbose
  implicit any:      auth_admin
  implicit inactive: auth_admin
  implicit active:   auth_admin_keep
``` That is a denial of service the session can
perform on itself, and it is fail-closed — with no daemon there is nothing to pay through, and
the limits on disk are untouched. (There is nothing else on disk worth touching: a restarted daemon
re-reads what has been spent from the chain, so it cannot come back up with a stale figure — and
the one thing it does read back, the settling lock, can only make it refuse.) It is also the reason chip402's own four polkit
actions are `auth_admin` and never `auth_admin_keep`: the one thing that must not be silently
reusable is the authority to raise a cap.

And this must **succeed** as me with no password — that is the product:

```bash
./bin/chip402.ts pay http://127.0.0.1:4403/secret     # pays, within the caps
./bin/chip402.ts pause                                # anyone can hit the red button
```

## The panel

One currency on screen at a time, USDC by default, and a header toggle that flips the whole
panel. The daemon's `status` frame already carries both assets, so the flip is a client-side
selector over data the panel is holding — no new verb, no round trip.

```
┌──────────────────────────────────────┐
│  [ USDC ]  HBAR        testnet       │   bar: 🪙 $8.38  ← left to spend
│                                      │
│  $18.77 in the purse                 │
│  ▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   │
│  $0.01 / $2.00 · resets in 10h       │
│                                      │
│  ⌄ Limits                            │
│                                      │
│  DAILY ALLOWANCE              $2.00  │
│  [ Off ][$1.00][$2.00][$5.00][$10.00]│
│  [ $    ][✓]                         │
│                                      │
│  MAX PER PAYMENT              $0.25  │
│  [$0.05][$0.25][$1.00][$5.00]        │
│  [ $    ][✓]                         │
│  ────────────────────────────────────│
│  $0.01  api.example.com           ↗  │   ← a row the mirror node returned
│  full history on HashScan ↗          │
│  [        ⏻  PAUSE        ]          │
└──────────────────────────────────────┘
```

**The bar shows what is left to spend today, not what has been spent.** Money on a bar is read
as money you have, so it carries `min(allowance − spent today, balance)` — which is exactly the
pair of tests `policy.ts` applies, so it is the real length of the leash rather than a number
that only means something once you know the allowance. The spend against the allowance lives in
the popup, where there is room to label it.

**Presets are a ladder, not a ceiling.** Tapping one is a single tap and a single password
prompt, which is what pocket money usually wants. Beside them is a free-text box carrying the
asset's own currency sign, so you type a bare number and Enter — any amount the asset can
express, down to one micro-USDC or one tinybar. The box turns red on anything the daemon would
refuse, so a typo never costs you a password prompt that then fails. Both routes send the same
admin verb; `test/planes.test.ts` covers the range and the refusals.

The ladders themselves live per asset in `src/networks.ts` and arrive over the socket, so there
are no magic numbers in the QML and HBAR's tiers can differ from USDC's.

**Topping up is not a setup step.** The account id, the EVM address and a QR of it live under a
`Top up` disclosure for the life of the purse, not just during setup, and both identifiers copy
to the clipboard on click — an address copied by eye is an address with a typo in it.

**And the address cannot be pointed somewhere else.** This is the obvious attack on any QR a
wallet shows, so it is worth saying exactly what stops it — and, first, what does *not*.

*Rotating the QR would do nothing.* Rotation is real practice, but it belongs to a different
problem: a login QR (WhatsApp Web and friends) rotates every 20–60 seconds because the QR **is a
bearer credential**, and rotation bounds the window between someone photographing it and using
it — that window is exactly what [QRLJacking](https://github.com/OWASP/QRLJacking) attacks.
Transit tickets rotate for the same reason. Dynamic merchant QRs rotate to bind an amount and a
reference to one transaction, and to let a compromised code be revoked.

chip402's QR is none of those. It carries a **public receiving address**: capturing it grants
nothing, because the only thing you can do with it is send us money. Rotating a constant string
produces the same string. A refresh button is the same placebo — the address is a property of the
key, so it cannot go stale. What *can* go stale is the confirmation, so the panel shows when the
chain last agreed instead of offering a button that only feels reassuring.

The risks that are real here, and what each one gets:

| Risk | What it is | What chip402 does |
|---|---|---|
| **Truncated verification** | [Address poisoning](https://support.metamask.io/stay-safe/protect-yourself/wallet-and-hardware/address-poisoning-scams/) works *because* interfaces abbreviate to the first and last few characters, so a substitution hides in the middle. [Blockaid flagged 65.4M such transactions between January 2025 and February 2026](https://www.blockaid.io/blog/address-poisoning-the-growing-threat-draining-millions-from-crypto-users), of which about 316,000 succeeded. | The address is shown **whole and wrapped**, never elided. |
| **Nothing human-checkable** | Nobody compares 42 hex characters. | The account id carries its **HIP-15 checksum** — `0.0.10193689-wkdxo`. Five letters derived from the id *and the ledger*: change one digit and all five change (`0.0.10193688-stgpx`). That is a comparison a person will actually make. |
| **Clipboard hijacking** | Clipper malware swaps crypto addresses between copy and paste; [Microsoft flagged a Tor-based, worm-propagating one in June 2026](https://www.microsoft.com/en-us/security/blog/2026/06/17/crypto-clipper-uses-tor-worm-like-propagation-for-persistence-control/). | The QR path never touches the clipboard. Copy stays for convenience; the QR is the primary. |
| **Wrong network** | Testnet and mainnet addresses look identical. | See below — the QR deliberately carries the recoverable identifier. |
| **A lying panel** | Nothing in the panel can prove the panel is honest — and a "confirmed on chain" badge beside a QR is worse than nothing, because you cannot see what the square encodes, so it reassures you about something you have no way to check. | **verify on HashScan ↗** and nothing else. Comparing what a public explorer says against what the panel says is the one verification that does not rest on trusting the panel. |
| **A lying daemon** | — | The address is derived from the key (`publicKey.toEvmAddress()`), not read from config, and is re-confirmed against the chain every 60s. See *the address is not a setting*, below. |

**The QR carries one of two identifiers, and you pick.** There is no payment-request URI on
Hedera — no `hedera:` scheme, no HIP for it, and HashPack's deeplinks are restricted to dApps in
their own browser *by their security policy*. So no scan can open a wallet with the send screen
already filled in. What a scan can do is fill the recipient once you are inside **Send → scan**,
and for that the payload has to be the identifier that wallet's scanner parses. Hedera wallets
expect the account id — the ecosystem convention is the id as free text, optionally with its
checksum — while the Hedera faucet and EVM wallets want the `0x` address. Rather than guess, the
panel offers both with a two-chip toggle and labels which is which, alongside the network.

The default is the account id, because that is what a Hedera wallet scanner reads. It is worth
knowing what each one costs if it is used on the wrong network:

- `0.0.10193689` means **a different account on every Hedera network**. That id exists on mainnet
  too, owned by a stranger, with a different alias — verified against the mainnet mirror node.
  A wrong-network send there is gone.
- The EVM address is derived from the key alone, so **the same key controls that alias on every
  Hedera network**. A wrong-network send auto-creates an account we can still get into.

Same mistake, recoverable instead of fatal — which is why the panel prints the network under the
QR rather than leaving it to the header. The HIP-15 checksum is network-bound and would catch
this too *if the receiving wallet validates it* — which is exactly the assumption not to build
on; see the note below.

**The address is not a setting.** The daemon derives it from the key it holds at the moment it
answers. There is no field an attacker could edit to change what the panel displays, because the
displayed address *is* a property of the key that would spend the money — substituting it means
substituting the key, which is TPM-sealed and root-owned. `/etc/chip402/config.json` is
`root:root 0644`, so even the account id it is checked against is out of reach — and it is
shape-checked at start-up, because it is interpolated into a mirror-node URL path and "root wrote
it" is not the same claim as "it is an account id".

On every chain read the daemon compares that account against the key, by public key on record or
by EVM alias, and **that check now costs something**: three consecutive readings a minute apart
that a *different* key controls the account, and payment is refused with a reason naming
`sudo chip402ctl setup --import`. The panel stops showing the address at the first such reading.

It is worth being precise about what that check is for, because "the chain is the ledger" makes
it easy to assume it is a leftover from when there was a second one. It is not. It asks a
different question — **is the account we read the chain *about* the account this key can spend
*from*?** — and deriving spending from the chain made it matter *more*, not less. `accountId` is
the id every mirror query is built from, so a purse naming somebody else's account reads a
stranger's balance, measures the day's allowance against a stranger's transactions, and offers a
top-up address for an account it could never spend from. Nothing is stolen — every payment it
signs is refused at consensus for a bad signature — but nothing works either, and the panel
insists otherwise the whole time. That is the failure the deny converts into an instruction.

The reason it took three readings and a rewrite to get there is the failure mode in the other
direction. The check used to be a two-state boolean, so everything it did not *recognise* —
a threshold account, a `KeyList`, a `ProtobufEncoded` key, a mirror node having a bad minute —
collapsed to "no". Had that gated payment, it would have bricked a perfectly healthy purse. So
it is three states now: a positively-parsed matching key or a matching EVM alias allows;
a positively-parsed *different* key denies, after three readings; **and anything we cannot read
allows**, and is shown as unverified. `test/policy.test.ts` asserts the null case allows, under
the name `ANTI-BRICK`.

The QR itself is rendered by `qrencode` on argv into the session's own `0700` runtime directory
(`/run/user/1000`, `drwx------`), and `zbarimg` on the rendered file returns the identifier —
which is how it is checked rather than assumed. It is drawn in the theme's own two colours rather
than black on white: whichever of the foreground and the popup surface is lighter becomes the
paper, so the code keeps the dark-on-light polarity scanners expect while sitting on a card that
matches the rest of the panel.

`test/panel.test.ts` runs that rule — lifted out of `ui/Chip.qml` rather than restated — over six
real themes in both directions, renders each with the exact `qrencode` argv the panel builds, and
reads every one back with `zbarimg`. Contrast against the 3:1 scanners need, measured: 6.66:1 on
the lightest theme installed here (`rose-pine`) up to 21:1 (`vantablack`), 9.65:1 on the one this
machine is running (`osaka-jade`). A single number belongs to a single theme, which is why the
claim is now the range and the floor.

Both identifiers carry a visible copy button, because a top-up from a laptop browser never
touches the QR — it is a paste into a faucet or an exchange.

> **Do not rely on wallets validating the HIP-15 checksum.** In `@hiero-ledger/sdk` 2.85.0,
> checksum *generation* is correct but *validation is a silent no-op*: `AccountId.fromString`
> discards the parsed checksum, `validateChecksum` returns early when the checksum is null, and
> `EntityIdHelper._parseAddress` never matches at all because its regex literal begins with a
> stray `"`. A wrong-network id, a garbage checksum and an altered account number are all
> accepted. chip402 therefore treats the checksum as something for a **human** to compare, and
> puts the recoverable identifier in the QR rather than trusting anyone else's validation.

What is *not* covered: something already running as root, or a compromised TPM. Both own the
daemon outright, at which point the purse is the least of it.

**Six rows, and then a link.** The list is today's, newest first, hard-capped at six — the panel
is a glance, not a ledger viewer, so it neither scrolls nor grows. The status frame is capped too,
at twenty rows per asset: the *figure* is summed from every transaction the chain returned, but
there is no reason to push a busy day's worth down the socket on every change so that six of them
can be drawn.

Underneath sits **full history on HashScan ↗**, and that is deliberately a link rather than more
rows. Everything the panel could show further back it would have to show worse: the host names are
chip402's own labels, capped at 100,000 and written after signing, because the chain knows
the counterparty as `0.0.9584959` and not as `printwright.liftbyai.com`. So the panel keeps the
named, filtered, recent view, and "everything, ever" is answered by a public explorer — which is
also the honest place for it, being a source that is not us. There is no local log to offer
instead, and that is the point rather than an omission.

**Every row opens on HashScan, and every row is a transaction that happened.** The list is not
something the daemon keeps — it is the mirror node's answer to "what did this account pay since
local midnight", so there is no row for a payment that did not settle and no link that fails to
resolve. The transaction id is ours, read out of the bytes the daemon signed, and never the
seller's claim. The host beside the amount *is* ours: a label written after signing, because the
chain knows the counterparty is `0.0.9584959` and not that it was `printwright.liftbyai.com`.

That label is decoration in the sense that matters — no number and no decision can be reached
from it — but it is not disposable. "$1.60 to printwright.liftbyai.com" is a line you can read;
"$1.60 to 0.0.9584959" is a line you have to go and look up, and seeing where the agent's money
went without a deep dive is most of what the panel is for. So the map is kept generously (100,000
rows, far more than a day can show) and is **carried across an upgrade**: `Purse.open`
reads host names out of the previous build's receipt list once, takes the two strings and nothing
else — not the amounts, not the counters, not the seller's settled claim, all of which the chain
answers now — and the first write afterwards drops the old shape for good. Where there genuinely
is no label, the account id is shown instead.

**Pause is one click and no prompt; resume raises the polkit dialog.** The asymmetry shows up as
a different button, never as an explanation printed at the user. When the daemon is not running
the panel offers **START**; when it is running but this login predates your `chip402` group
membership, it says so and offers nothing, because no button would help.

**And when the daemon comes back, the panel comes back.** That sentence was false for most of
this project's life, in a way nothing here caught. A Quickshell `Socket` that has once *failed*
to connect is wedged: assigning `connected = true` again does nothing, because the desired-state
flag it writes already holds that value, and reassigning `path` does not reset it either — both
measured, against a socket taken away and put back. So the five-second retry fired forever and
reconnected never. One `systemctl restart chip402` left the panel showing **START** for as long
as the shell ran, and pressing START then spent a password asking systemd to start a daemon that
was already up.

The retry now destroys the `Socket` and builds a new one, which is the only thing that recovers
it. `test/panel.test.ts` is the guard: it runs the real `ui/Purse.qml` under Quickshell against a
socket that goes away, stays away long enough for one retry to find nothing there — a shorter gap
reconnects even on the broken build, which is what made this hard to see — and then comes back.

Layout notes, since the panel is part of the deliverable. Both limit rows sit on one five-column
module: every chip is the same width, the custom field is exactly one cell — so it reads as one
more chip, the one you fill in yourself — and the tick is half a cell, because a single glyph
wants to be square rather than chip-shaped. Both of those edges land on the module's column
lines, so the air to their right reads as deliberate rather than as a row that ran out. Spacing
is three steps and nothing else (within a line, between rows, between groups), and money gets a
fixed column so hosts align however long the amount is.

## The code

Twelve core files, each with one job, each meant to be read aloud: 1,465 lines of code, 2,619 with
the comments, which are part of the deliverable rather than decoration. `grep -rn "SECURITY:"
src/ ui/` is the outline of the security half. The numbers below are `wc -l`, and
`test/readme.test.ts` recomputes them rather than trusting this table — two rows had quietly
drifted before it did.

| File | Job | Code / total |
|---|---|---|
| `src/networks.ts` | Two frozen rows: mirror node, both token ids, and the panel's preset ladders (a ladder, not a ceiling). **The mainnet switch.** | 72 / 109 |
| `src/money.ts` | `bigint` base units, decimals-aware. No function takes two assets, so no function can need a price. | 36 / 61 |
| `src/ids.ts` | What a Hedera id looks like, in one place instead of five. Pure, so even `policy.ts` can import it. | 6 / 25 |
| `src/safe.ts` | `readSecret` (`O_NOFOLLOW` + `fstat`), `writeAtomic` (temp, flush, rename), `readJson` (size-capped, refuses), `appendLine`/`readTail`/`removeFile` (degrade, never refuse). | 107 / 199 |
| `src/policy.ts` | **Pure.** The whole decision on one screen: no I/O, no clock of its own, no path to the key. Also where local midnight is defined, because that is the one thing about "today" that is ours. | 70 / 158 |
| `src/fetch.ts` | The hardened fetch handed to the SDK. Manual redirects, byte cap, deadline, `accepts[]` cap. | 83 / 132 |
| `src/chain.ts` | **What the chain says, and the only place it is asked.** Five facts: balances, the x402-payment filter, today's spend, "has this transaction happened yet", and the three-state key check. | 223 / 416 |
| `src/purse.ts` | Limits, `paused` and the settling lock — on disk, **only** the limits and `paused` in `purse.json`, and the lock in a file of its own. No spending state, no host names, nothing that grows. | 219 / 435 |
| `src/labels.ts` | The `txId → host` names, append-only in a file of their own. Structurally incapable of stopping the daemon — reads and writes alike. | 67 / 150 |
| `src/wallet.ts` | **The guarded signer** — the enforcement point, the only `createClientHederaSigner` in `src/`, the lock taken on the way to the key, and the settlement wait. | 285 / 489 |
| `src/protocol.ts` | The NDJSON contract: two frozen verb sets, where the sockets live, plus the client the CLI and MCP server use. | 80 / 132 |
| `src/daemon.ts` | Two listeners in one process. The plane is the listener. Payments serialized through one chain. | 217 / 313 |

Clients: `bin/chip402.ts` (spend plane only), `bin/chip402ctl.ts` (admin plane + `setup`),
`bin/mcp.ts` (two tools, spend plane only). Panel: `ui/Chip.qml` (bar item and popup),
`ui/Purse.qml` (the socket), `ui/ChipIcon.qml` + `ui/assets/chip.svg` (the mark, drawn in white
and recoloured to whatever theme is on), `ui/chip402.policy` (four polkit actions).

## Tests

`npm test` — no network, no install, no key. One file needs Quickshell, and says so when it is
missing rather than passing quietly.

| File | Proves |
|---|---|
| `money.test.ts` | Float rejection, both decimal boundaries, overflow, that no exported function sees two assets, and that `ui/Purse.qml`'s own `money()` — lifted out of the shipping file and run — agrees with `format()` on every interesting value. |
| `safe.test.ts` | The two contracts, as the opposites they are. `readSecret`: a symlink refused by `O_NOFOLLOW`, a world-readable key refused, a `0440` systemd credential **accepted** — the group bit is skipped on purpose and that is asserted in both directions. `readTail`: a file past the cap read from the end with the half-line dropped. |
| `chain.test.ts` | The payment filter, against a **verbatim capture of the public testnet mirror node**: $1.62 and ℏ0.00 to the unit, failures and owner-initiated transactions dropped, incoming transfers not counted as spending — and the ℏ0.02 regression, which moves to the wallet that actually made it when the account id changes. Plus the three states of the key check, including `ANTI-BRICK`; the same shapes run through `setup --import`'s stricter check beside it; and 1,500 dust transfers in, which must not make spending uncomputable. |
| `policy.test.ts` | The decision table, run twice — once per asset — plus the cross-asset cases. The security proof. Includes: a chain that has never answered denies rather than reading as zero, a settling payment denies, `verified === null` **allows**. |
| `purse.test.ts` | That `purse.json` holds policy and *nothing* else, that no arithmetic happens in it at all, that nothing chain-shaped survives a restart, that upgrading from the old build carries the host names out and *only* those, and that a truncated temp file never becomes the purse. Plus the settling lock: what it may carry, that damage to it reads as *held* rather than as free, that a garbled deadline cannot outlast a real one, and that it is taken and released under `node --permission`. |
| `labels.test.ts` | That nothing about the label store can stop the daemon — truncated, corrupt, oversized, or a directory where the file should be — with the contrasting `purse.json` refusal asserted beside it. Plus append-only behaviour, last-line-wins, and the one-time migration out of the old file. |
| `seller.test.ts` | The hostile-seller table, against real HTTP servers, the real SDK wrapper and a mirror node on loopback — including a seller that takes a signature and never settles, which costs nothing. |
| `planes.test.ts` | The authority proof: disjoint verb sets, admin verbs refused on the spend socket, the plane is never read from a field, the socket modes and the `0750` runtime directory under the unit's own umask, and every polkit action the panel can ask for. |
| `signer.test.ts` | The enforcement proof: every denial leaves the stub signer uncalled, no lane closed and nothing recorded. Plus a second signature in one payment throwing, both ways the settling lane reopens, a receipt that says what the chain says even when the poll loop reopened the lane first, and a signer that refuses not leaving the lane shut behind it. |
| `daemon.test.ts` | Two concurrent payments against a cap that allows one → exactly one pays, bounded by the chain rather than by a counter. The indexing gap denying and then clearing. **The restart attack**: pay, deny, restart the daemon inside the indexing window, and the next payment must still be refused. No TCP port. No key in any reply. A misshapen `accountId` refusing to start. |
| `mcp.test.ts` | The product, end to end and out of process: a real MCP client → `bin/mcp.ts` → daemon → hardened fetch → a real x402 seller. Only the signature is a stub. The seller's body is a fence-forgery attempt, and it stays in its own block. Plus a seller whose answer is over the cap in a script where a character is three bytes: the cap is bytes, the notice counts bytes, and the cut lands on a character boundary. |
| `readme.test.ts` | The claims in this file that a script can check: the line counts in the table above, the totals in the sentence above it, the number of core files, and the label cap. Two table rows had drifted before this existed. |
| `panel.test.ts` | The real `ui/Purse.qml`, under Quickshell, against a daemon that goes away and comes back: it must reconnect on its own. Skipped, loudly, where Quickshell is not installed. |
| `live.test.ts` | A real testnet payment, then the same mirror query the daemon makes, asked independently — the panel and the chain must agree for both assets. HBAR by default, because a token transfer to an account that cannot hold the token fails at consensus and proves nothing; the test says so before paying rather than after. It tells an outage apart from a defect: a transaction still absent from the mirror node past its validity window was never submitted, so it asserts the fail-closed half (nothing counted, lane reopened, receipt honest) and fails naming the **facilitator** and the id. Plus the mirror node's own `type=debit` filter, checked against real history, because `src/chain.ts`'s fallback rests on it. Off unless `CHIP402_LIVE=1`. |

## Not built, on purpose

Facilitator discovery · TCP transport · bearer tokens · `curl` from QML · **a local ledger of any
kind** — no spend counters, no receipt file, no reserve/commit/release, no per-receipt "confirmed"
flag, no in-flight amount tracker; every one of those is a mechanism for reconciling a copy that
should not exist · a per-host circuit breaker · log rotation · approval dialogs · key-rotation
machinery · per-agent identity on the socket · **a seller allowlist**.

The settling lock is the one thing on that list's edge, so it is worth being exact: it is not a
reserve and not an in-flight *amount* tracker. It holds an id and a deadline, it can only ever
deny, and nothing reconciles it against anything — the sum is still the mirror node's answer and
nothing else. A lock that had to be balanced against a number would be the thing this list refuses;
one that expires on its own is not. `test/purse.test.ts` asserts its shape as well as its effect.
