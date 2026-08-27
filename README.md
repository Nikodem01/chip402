# chip402

**A hard-capped Hedera purse that lets a local AI agent pay for things, without ever giving it a key.**

The agent gets one verb — `pay(url)`. It fetches the URL, and if the answer is `402 Payment Required`
it settles the invoice and returns the bytes. No allowlist, no per-seller setup, no prompt, no
approval dialog. It never sees the private key, never learns what x402 is, and cannot spend past the
day's allowance however badly it behaves or whoever it talks to.

---

## Why this exists

[HTTP 402](https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402) was reserved in 1997 and
left unimplemented for twenty-seven years, because there was no way to move a cent over the web
without an account, a card and a checkout. [x402](https://docs.x402.org) is that missing piece, and
Hedera is a sensible place to run it: sub-cent fees, three-second finality, and USDC.

Hedera's own framing of what it is for is
[per-request metering](https://docs.hedera.com/solutions/ai/x402/index) — "AI agents paying for API
calls, context, datasets, inference, or tool use on demand", "billing for consumption rather than
subscriptions". It is also explicit about what x402 is *not*: **"not a general 'agentic wallet'…
one well-scoped primitive, not an autonomy framework."**

That is the gap. x402 tells you how to pay an invoice. It says nothing about how to let something
you do not trust hold the money. chip402 is the part that goes around it.

**The problem, stated plainly.** To let an agent buy, you have to let it spend. But an agent is
exactly the thing you cannot hand a private key: it reads your filesystem, it pastes things into
transcripts, and it can be argued into anything by content it just fetched. And a confirmation
prompt per payment defeats the point — you become the bottleneck you were removing.

So: how do you delegate spending to something you do not trust, with no prompt, and still bound the
loss?

---

## Three boundaries, and they fail differently

### 1. The agent cannot sign

There is one door to the key, and the check is bolted to the same side of it as the key.

- **A different uid holds it.** The daemon runs as the system user `chip402`; the key is a
  TPM2-sealed systemd credential decrypted into a read-only tmpfs (`dr-x------`, root-owned, reached
  by the service user through an ACL) that your uid cannot open at all. `grep -r` in your home finds
  nothing. That boundary needs no judgment from anyone at runtime, which is what makes it the one
  that cannot be talked around.
- **The only way money moves is a socket call.** No key on disk in your home, no signing path, no
  alternative — so the daemon is a chokepoint rather than one option among several.
- **The check is inside the only function that touches the key.** `src/wallet.ts` wraps the Hedera
  signer in one of its own that runs `policy.decide` first and throws on deny. Deliberately *not*
  the SDK's `onBeforePaymentCreation` hook: a hook is a convention that a direct call to the scheme
  walks straight past. `createClientHederaSigner` appears exactly once in `src/`, and
  `test/signer.test.ts` counts it.
- **`src/policy.ts` is the whole decision, on one screen, pure.** No I/O, no clock of its own, no
  path to the key. Nothing to mock, nothing to be stale, no order of operations to get wrong — and
  `test/policy.test.ts` proves the purity by construction, checking every value-import it takes is
  pure too.

### 2. The agent cannot administer

**Two planes, and the plane is whichever socket accepted you.** Not a token, not a field in the
message, not a role — a file permission bit.

|  | Spend plane | Control plane |
|---|---|---|
| socket | `/run/chip402/spend.sock` | `/run/chip402/admin.sock` |
| mode | `0660 root:chip402` | `0600 root:root` |
| who | your shell, your agents, the panel | root, through `sudo chip402ctl` |
| verbs | `pay`, `purse`, `pause` | `resume`, `allowance`, `max` |

The verb sets are disjoint, and the daemon reads the plane off the listener that accepted the
connection — never off the message. `{"cmd":"resume","plane":"admin"}` arriving on the spend socket
is an *unknown verb*, because on that socket `resume` does not exist. `test/planes.test.ts` pins
that, and pins the socket modes under the unit's own `UMask=0077`.

**Pause is free; resume is not.** An agent that pauses the purse has denied only itself. An agent
that could resume it would be the entire attack. That asymmetry is the whole authorization system.

Raising a limit needs a password every single time: `/etc/sudoers.d/chip402` sets
`timestamp_timeout=0`, so a fifteen-minute sudo timestamp from an unrelated command can never be
reused, and all four polkit actions in `ui/chip402.policy` are `auth_admin` rather than
`auth_admin_keep`.

### 3. The agent cannot exceed the limits

| Limit | Bounds | Set by | Enforced by |
|---|---|---|---|
| **Per-payment cap**, per asset | one bad invoice | control plane | `policy.decide`, **and** independently by the SDK's `spendControls` |
| **Daily allowance**, per asset | a runaway loop, and every hostile seller combined | control plane | `policy.decide`, against a figure anchored to the chain. `0` switches the asset off |
| **The account balance** | everything, absolutely | you, by how much you fund it | **Hedera consensus**, and the facilitator's own pre-settlement balance check. Not our software at all |
| **Pause** | everything, instantly | **pause: anyone. resume: control plane** | `policy.decide`, first line |

### …and the third one is the one that matters

The first two boundaries are mechanical. A uid and a TPM cannot be phished, because no human
judgment is involved. Raising a cap *is* human — polkit cannot be forged, but a convincing dialog at
a plausible moment can still get you to type a password.

Which is why **the purse should be small**. The honest number: a fully hostile agent, with a
successful phish behind it, drains what is in the account. Nothing above that is at risk, because
nothing above that is there.

So keep the bulk somewhere the machine has no key for, and top this account up. The panel shows the
address and a HashScan link to it, so you can check it against a source that is not us. That is not
a workaround for a missing feature — it is the feature. The daily allowance shapes the *rate*; the
balance bounds the *loss*, and it does so at consensus rather than in a TypeScript file.

---

## How the purse knows what it has spent

This is the part worth reading, because it is where the design used to be wrong.

Two questions have to be answered before every payment: **what may I spend** (policy — ours, and it
can come from nowhere else) and **what have I spent today** (a fact about the chain). The second one
used to be re-derived from the mirror node immediately before and after every payment, by walking
every transaction of the local day in pages of a hundred.

That was honest and it cost more than it looked:

- **It could be jammed from outside.** Every transaction the account so much as appeared in counted
  against the page bound, incoming ones included. Twelve hundred dust transfers *in* — free on
  testnet, about $0.12 a day on mainnet — and the daemon could no longer say what had been spent, so
  it refused to pay until local midnight.
- **It forced payments into single file.** Two payments cannot both be measured against a reading
  taken before either of them signed, so the daemon ran them one at a time and each one waited for
  the chain to catch up. A ceiling of roughly one payment every few seconds. That is not a purse
  that can pay per request for a metered API, which is the second use case Hedera lists.
- **It was expensive to nobody's benefit.** Around 98 MB a day against a free public mirror node to
  sit *idle*, and about 320 MB on a busy one — almost all of it spent re-deriving a figure the
  daemon could already state.

**The observation that fixes all three: the daemon signed every transaction that can move the
figure.** Nothing else can. So it does not need to be told.

```
spent today  =  what the chain said when this daemon started
             +  every payment of ours the chain has confirmed since
             +  every payment authorised and not yet answered for
```

- The amount is committed **on the way to the key**, before anything is signed. `policy.decide`
  reads the figure and `Purse.authorize` raises it with no `await` between them, so any number of
  payments running at once are counted *exactly*. The lock is not replaced by a smaller lock; the
  race is closed at the only place it could open.
- The chain is asked about each payment by **its own transaction id** — 917 bytes — rather than by
  re-reading the day.
- An authorisation is answered for in exactly two ways and there is no third: the mirror node shows
  the transaction, or the clock passes `validStart + TransactionValidDuration + the indexing
  margin`, after which Hedera would not accept it and the mirror node would never have started
  showing it. **Nothing is given back, because nothing was taken** — a payment that never settles
  simply never enters the figure. That stopped being hypothetical when `x402.org`'s facilitator
  began verifying payments and then not settling them: chip402 signed once, the receipt said
  `onChain: false`, the day's figure never moved, and the amount stopped counting on its own.
- **Counted exactly once**, whichever of the chain's two answers lands first. A reading of the day
  that contains the transaction and a direct lookup of its id can arrive in either order; adding the
  amount on the second without checking the first charges the day twice. That was a real bug, found
  by a test that expected ten payments out of an allowance for ten and got nine, and
  `test/purse.test.ts` now pins both orderings.

### The balance is allowed to be old

Deliberately, and for a reason about the chain rather than a tolerance somebody picked: **only this
purse's own key can make its balance smaller.** So the balance as the chain last reported it, less
everything that has left since, is a lower bound that stays true however long ago the reading was
taken. Money arriving only ever makes it pessimistic — which is the direction a spending check is
allowed to be wrong in.

There is no staleness denial any more. It bought nothing, and it cost a purse that stopped working
whenever somebody else's REST API did.

### Why this cannot repeat the bug it looks like

The previous build kept a `spent` figure too, and got it wrong: it carried two HBAR payments made by
a wallet the machine no longer held across a `setup --import`, and charged a fresh account's
allowance for money that account had never spent. Nothing was attacking it. So the difference is
worth being exact about.

| | then | now |
|---|---|---|
| where it lived | `purse.json`, rewritten on every payment | memory. A restart re-asks the chain |
| whose it was | nothing on it said | tagged with the account **and** the local day, and discarded rather than carried when either changes — checked again in `policy.ts`, where the decision is |
| what re-derived it | nothing, ever | the chain seeds it at start-up and at local midnight, and a reading may **raise** it but never lower it |
| what reached disk | the figure itself | never the figure |

What *is* on disk is the in-flight list, and only that: `{asset, amount, txId, deadline}` per payment
signed and not yet answered for. It exists for one reason — so that a restart between the signature
and the chain showing it does not forget what it already authorised and let the same allowance be
spent twice. That was demonstrated end to end before it was fixed
(`systemctl restart chip402` inside the indexing window bought a second payment, and
`Restart=on-failure` does it unattended), and `test/daemon.test.ts` runs the whole attack.

**Every entry in that file dies within a little over two minutes of being written.** Nothing in it
can walk into another day or another account, because nothing in it lives long enough to try.

### Three files, three deliberately different failure modes

Sharing one file would mean sharing one failure mode, and it would have to be the strictest.

| `/var/lib/chip402/…` | holds | if it cannot be read |
|---|---|---|
| `purse.json` | the limits and `paused` | **refuse to start.** "I do not know the limits" must never become "there are no limits" |
| `labels.jsonl` | host names for payment rows | **carry on with fewer names.** Losing all of them costs rows that show `0.0.9584959` instead of a hostname, and nothing else |
| `inflight.json` | what is signed and unanswered | **assume the whole allowance is committed**, for as long as any real entry could have lasted. Damage costs a bounded stretch of denial, never an extra payment |

`labels.jsonl` is append-only and capped at 100,000 entries — one short append per payment rather
than an atomic rewrite of the limits, so a display nicety can never fail a payment or stop the
daemon starting. Nothing it holds can reach a decision: `hostFor` is read by the status snapshot and
by nothing else, which is what makes it legitimate local state where a local count of spending was
not. The chain cannot answer "which host was `0.0.9584959`?", so there is no second copy to drift
from.

---

## What it costs the machine

Measured against the public testnet mirror node, not estimated.

| | before | now |
|---|---|---|
| idle, per day | ~98 MB, 1,440 polls | **nothing at all** |
| a 300-payment day | ~320 MB | **~4 MB** |
| requests per payment | ~7, two of them page walks | ~3 point lookups of 917 bytes |
| a day's full reading | 23,072 B + 90 KB/page | 740 B + 40 KB/page |

The reading is event-driven, and the events are the ones the daemon cannot cause itself:

- **at start-up** — what a *previous* daemon spent today, the one thing this one cannot know.
  Retried until it lands; nothing may be paid before it does.
- **at local midnight** — the day the figure is measured for has changed. One scheduled reading.
- **when a human looks** — a panel connecting or a `purse` command asks for a page, dropped if the
  last reading was seconds ago.
- **after paying** — one page, so the payment appears as a row the chain returned. Not awaited, and
  no decision waits on it.

The 740-byte figure is one query parameter: the accounts endpoint bundles a page of recent
transactions into its answer unless told `transactions=false`, and the daemon was parsing those rows
out and throwing them away.

---

## Install

Arch/Omarchy, Node 26.7.0 or newer. One `sudo` step, and it installs no secrets — the key is
generated later.

```bash
git clone https://github.com/nikodem/chip402 && cd chip402
sudo ./install.sh
```

`install.sh` creates the system user, builds `node_modules` **itself** from the committed
`package-lock.json` with `npm ci --ignore-scripts --omit=dev` into a root-owned tree (so what runs
is what was reviewed, installed without letting any package run code on your machine), takes a
root-owned copy of your `node`, installs `chip402.service`, the four polkit actions, the never-cached
sudo rule, and the panel plugin. It is idempotent.

Then:

```bash
sudo chip402ctl setup            # generate a key, seal it to the TPM, fund it, complete the account
sudo systemctl start chip402
omarchy plugin enable chip402 && omarchy restart shell
# log out and back in — group membership is what lets you reach the spend socket
```

`setup` prints an EVM address, waits while you fund it, and completes the account. Already have a
key? `sudo chip402ctl setup --import [<accountId>]` — that door is *stricter* than the daemon's own
key check on purpose: it refuses any account shape it cannot positively prove the key controls,
because refusing at import time costs one command and discovering it at runtime costs a purse that
cannot pay and says nothing about why.

A fresh install is **switched off**: paused, with a zero allowance in both assets. Set both from the
panel, or:

```bash
sudo chip402ctl allowance usdc 5.00
sudo chip402ctl max usdc 0.25
sudo chip402ctl resume
```

---

## Use

**From an agent**, over MCP stdio — `bin/mcp.ts`, two tools and no key:

```json
{ "mcpServers": { "chip402": { "command": "node", "args": ["/usr/local/lib/chip402/bin/mcp.ts"] } } }
```

- **`pay(url, method?, body?)`** — fetch, paying if the answer is 402. A denial comes back as a
  normal answer with the reason, not a crash, so the agent can decide whether to ask a human.
- **`purse()`** — what is left today, per currency, and today's payments as the mirror node reports
  them. Read-only: there is no tool here that can raise a limit or resume a paused purse.

The seller's bytes come back in **a content block of their own**, with none of our framing inside it
to close, between markers carrying a nonce drawn fresh per call that nothing which has never seen it
can write. `test/mcp.test.ts` drives a seller that tries to forge the boundary. The containment that
actually matters is elsewhere, though: a manipulated agent still cannot spend past the allowance.

**From a shell:**

```bash
chip402                       # status: balances, what is left today, recent payments
chip402 pay https://…         # buy something
chip402 pause                 # the big red button. No password, no confirmation
```

**Try it end to end** without leaving the machine — a real x402 seller on loopback, with a real
facilitator and a real transaction on HashScan afterwards:

```bash
node demo/seller.ts --pay-to 0.0.5005 --asset hbar --price 0.01
chip402 pay http://127.0.0.1:4403/secret
```

The seller picks its own facilitator (`--facilitator`, or `CHIP402_FACILITATOR`), which is the point:
**chip402 never sees that choice and nothing in the design rests on it.**

---

## What a hostile seller gets

| Attack | What happens |
|---|---|
| **Ask for more than the cap** | Refused by `policy.decide`, and independently by the SDK's `spendControls` before the offer is even selected |
| **Ask many times** | Bounded by the daily allowance, then by the account balance |
| **Take the signature and never settle** | Costs nothing. The figure only moves when the chain confirms it, and the amount stops counting on its own once the transaction can no longer reach consensus |
| **Name us as `feePayer`** | Refused. We would pay the network fee for a transaction we did not initiate, and it would make the payment invisible to the sum as well |
| **Name us as `payTo`** | Refused. The transfer nets to zero, the content arrives, and the day's allowance is gone — a free lunch billed to the agent's leash |
| **Offer a look-alike token id** | Simply fails to resolve. There is no allowlist to be missing from |
| **Offer `hedera:mainnet` to a testnet purse** | Refused, never translated. chip402 converts nothing |
| **Downgrade to x402 v1** | No client is registered for v1 at all, and `policy.decide` says so again |
| **Plaintext `http://`** | Refused, except on loopback, where there is no network path to sit on |
| **Redirect somewhere else mid-payment** | The policy sees the URL that *actually answered*, recorded by our own fetch — not one the SDK re-derived. Off-origin redirects are refused |
| **Never finish the response** | Every request has a deadline. Bodies are bounded at one megabyte; a 402 may offer at most eight ways to pay |
| **Prompt-inject through the paid body** | The bytes go in their own block behind a per-call nonce. And a manipulated agent still cannot exceed the allowance |

---

## What this costs, stated rather than papered over

- **The mirror node is trusted for two things**: the balance, and what a *previous* daemon spent
  today. One that under-reported our own transfers at start-up could let the purse exceed its daily
  allowance — bounded, absolutely, by what is in the account. That is the honest ceiling, and it is
  the reason the account should hold what you are willing to lose.
- **Nothing may be paid before the first reading lands.** A daemon that cannot reach the mirror node
  at boot will not pay. Once it has a day, an outage costs a stale display and nothing else.
- **A hostile agent still costs money.** It cannot exceed the allowance, but it can spend all of it,
  every day, on rubbish. The allowance is the dial.
- **At most 64 payments in the air at once**, after which a caller is told to retry. That bounds
  fan-out and the in-flight file, not spending.
- **This is a prototype.** Mainnet is written and reachable — change `network` in
  `/etc/chip402/config.json` and `src/networks.ts` has the row — and it is not what has been run.

---

## The code

Twelve core files, each with one job, each meant to be read aloud: 1,620 lines of code, 2,920 with
the comments. The comments are part of the deliverable — they say *why*, and several of them are
load-bearing arguments rather than descriptions.

| file | owns | code / total |
|---|---|---|
| `src/policy.ts` | **Pure.** The whole decision on one screen: no I/O, no clock of its own, no path to the key. Also local midnight, the one thing about "today" that is ours | 85 / 191 |
| `src/chain.ts` | Everything Hedera says, and the only place it is asked. Five facts, none of them ours | 216 / 405 |
| `src/wallet.ts` | **The guarded signer** — the enforcement point, the only `createClientHederaSigner` in `src/`, and the settlement chase | 309 / 536 |
| `src/purse.ts` | The limits, the kill switch, the day's figure, and the payments still in the air | 325 / 610 |
| `src/daemon.ts` | Two listeners in one process. The plane is the listener. The reading loop that mostly does not run | 234 / 370 |
| `src/fetch.ts` | The hardened fetch handed to the SDK — a hostile seller is the normal case | 83 / 132 |
| `src/safe.ts` | File operations that have to be paranoid, and the two opposite contracts they come in | 107 / 199 |
| `src/labels.ts` | The one thing chip402 knows that the chain cannot: which host an account id was reached at. Append-only, capped at 100,000 | 67 / 150 |
| `src/protocol.ts` | The two verb sets, and the line-framed socket protocol | 80 / 132 |
| `src/networks.ts` | Two networks, two assets each. The mainnet switch, in one place | 72 / 109 |
| `src/money.ts` | Decimal strings to base units and back, without a float anywhere | 36 / 61 |
| `src/ids.ts` | What a Hedera account id and a transaction id look like, in one place | 6 / 25 |

Clients: `bin/chip402.ts` (spend plane), `bin/chip402ctl.ts` (control plane, plus `setup`),
`bin/mcp.ts` (two tools, spend plane). Panel: `ui/Chip.qml`, `ui/Purse.qml`, `ui/ChipIcon.qml`, with
`ui/manifest.json` and `ui/chip402.policy`. Seller: `demo/seller.ts`.

`test/readme.test.ts` checks the numbers in that table against `wc -l`, and the label cap against the
code, because prose that counts something and is never counted again is how a document stops being
trustworthy.

## The tests

`npm test` — no install, no key, no network. The mirror node is a real HTTP server on loopback
speaking the real endpoints with the real row shapes, so almost nothing here is a stubbed number.

| file | proves |
|---|---|
| `test/policy.test.ts` | The decision table, run once per asset, plus the cross-asset cases. A figure measured for another account is refused. `verified === null` **allows** — an anti-brick case with real teeth |
| `test/signer.test.ts` | Every denial leaves the stub signer uncalled and nothing committed. A second signature in one payment throws. Payments in flight together cannot exceed the allowance between them |
| `test/purse.test.ts` | That `purse.json` holds policy and nothing else; that no figure reaches disk; that an in-flight list written for another account is discarded; that damage reads as *committed* rather than free; and that a payment is counted exactly once whichever of the chain's two answers lands first |
| `test/daemon.test.ts` | Three hundred concurrent payments stop at the allowance and never past it. Twenty run genuinely alongside each other. An idle daemon asks the mirror node nothing. **The restart attack**, end to end |
| `test/chain.test.ts` | That the walk is a superset of what the sum counts; that ten thousand rows of somebody else's dust cannot bound it; that a walk which stopped short says so |
| `test/planes.test.ts` | Disjoint verb sets, admin verbs refused on the spend socket, the plane never read from a field, the socket modes under the unit's own umask, and every polkit action |
| `test/seller.test.ts` | The wire, against sellers we did not write — including one that keeps a signature and never settles |
| `test/mcp.test.ts` | The product end to end and out of process: a real MCP client → `bin/mcp.ts` → daemon → hardened fetch → a real x402 seller. Only the signature is a stub |
| `test/safe.test.ts`, `test/money.test.ts`, `test/labels.test.ts`, `test/panel.test.ts` | The edges: credential modes, torn writes, decimal arithmetic without floats, a label store that degrades, and the panel's own bindings |
| `test/live.test.ts` | A real testnet payment, then the same mirror query asked independently. Off unless `CHIP402_LIVE=1` |

Shared builders and the loopback mirror node live in `test/support.ts`.

---

## The facilitator is the seller's, not ours

The facilitator adds the fee-payer signature and submits the transfer to Hedera. **The seller picks
it, chip402 never sees the choice, and nothing here rests on which one it is.** That is not an
oversight to tidy up later — it is exactly why the daemon reads the mirror node instead of the
`PAYMENT-RESPONSE` header the facilitator's answer arrives in. A facilitator can lie about settling,
or simply stop, and the purse's figures do not move either way, because they were never its figures.

It also works in our favour: the reference facilitator implementation checks the payer's balance
against the mirror node **before** it submits anything. So the balance ceiling is enforced twice by
parties that are not us — once there, and once at consensus.

## License

MIT. See `LICENSE`.
