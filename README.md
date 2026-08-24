# chip402

A spend-capped wallet for local AI agents, living in the Omarchy bar.

Agents can pay [x402](https://x402.org) invoices on Hedera testnet. You set a daily cap and a per-request cap. One switch on the bar pauses every payment. HashPack (or the Hedera faucet) tops the account up; the plugin only holds a local **operator** key that cannot spend past the cap.

This is not a general-purpose wallet. It is pocket-money chips for agents.

> **Prototype.** chip402 works end to end — real x402 invoices, real USDC, settlements
> confirmed on the Hedera mirror node — but it runs on **testnet** and has been exercised by
> its author and its test suite, not by other people's agents against other people's sellers.
> Mainnet is written and deliberately not armed; see
> [Testnet only, on purpose](#testnet-only-on-purpose). Treat it as something to try and
> take apart, not as production money infrastructure.

![chip402 panel](preview.png)

![Kill switch](assets/demo.gif)

## What you get

- Bar icon that greys out when paused and badges until the operator has USDC
- Panel with remaining pocket money, today's spend meter, caps, and a live ledger (HashScan links)
- Setup stepper in the panel: key → HBAR → key on record → USDC, one next action at a time
- Kill switch: the hero toggle. Off means nothing signs, even if an agent retries
- Local daemon on a unix socket at `$XDG_RUNTIME_DIR/chip402.sock` (mode `600`) so Claude Code
  / curl / any agent can pay — and no web page can, because browsers cannot open unix sockets
- Host allowlist (localhost only, until you opt in), https required for anything remote
- Caps are silent: chip402 never interrupts an agent to ask. It either pays or it does not
- Key file mode `600`, refused at start if looser

## Install

Needs Node.js 22+, `npm`, `curl` and `wl-copy` (wl-clipboard). The Hedera SDK is installed **outside** the plugin directory (the Omarchy validator forbids symlinks, and the SDK is large) — from the lockfile committed at `runtime/package-lock.json`, with `npm ci --ignore-scripts`, so the dependency graph that signs your payments is the one in this repository and no package's install hook runs. If `node` lives somewhere only a login shell would find it (nvm, asdf), set `CHIP402_NODE` to its path before starting the bar.

```bash
omarchy plugin add https://github.com/Nikodem01/chip402 --enable --yes

# one-time runtime + operator key
~/.config/omarchy/plugins/chip402/bin/chip402 setup --watch
```

`setup` prints an EVM address (`0x…`). Spend is **USDC** on Hedera testnet (`0.0.429274`). Then [top it up](#top-up-testnet-hbar-and-usdc).

Add the widget if the installer did not: `omarchy plugin enable chip402`.

Optional PATH helper:

```bash
mkdir -p ~/.local/bin
ln -sf ~/.config/omarchy/plugins/chip402/bin/chip402 ~/.local/bin/chip402
```

## Top up (testnet HBAR and USDC)

Play money only. The payments are real Hedera transactions; the value is not.

`chip402 fund` reprints these addresses any time.

### 1. HBAR — creates the account

The first HBAR sent to the `0x…` address [auto-creates](https://docs.hedera.com/learn/core-concepts/accounts/auto-account-creation) a Hedera account.

1. Copy the EVM address from `chip402 setup` or the panel.
2. Open the [Hedera testnet faucet](https://portal.hedera.com/faucet).
3. Paste the address and click **RECEIVE 100 TESTNET HBAR**.

Docs: [Hedera Testnet Faucet](https://docs.hedera.com/learn/getting-started/testnet-faucet). Limit is 100 HBAR per day. The faucet creates a *hollow* account (id + alias, no key yet); chip402 completes it on the next refresh with one cheap self-signed transaction. You do not have to think about that.

### 2. USDC — this is what invoices charge

Token id **`0.0.429274`**, 6 decimals. Use the same `0x…` address.

- **[Circle faucet](https://faucet.circle.com/)** — pick **Hedera Testnet**, paste the `0x…` address, request 20 USDC. One drip per address every 2 hours.
- **HashPack** — switch the wallet to testnet and send USDC `0.0.429274` to the `0.0.n` account id once it exists (`chip402 status`).

The panel's USDC step opens the Circle faucet. A few USDC is enough: the default per-request cap is 1 USDC.

## Pay something (local demo)

In one terminal:

```bash
chip402 demo          # x402 seller on :4403, 0.01 USDC per request
```

In another:

```bash
chip402 fetch http://127.0.0.1:4403/secret
```

The panel ledger should show the settlement. Click a row to open it on HashScan.

## Try a real seller (Printwright)

[Printwright](https://printwright.liftbyai.com) is an independent x402 marketplace for licensed 3D-printable models. Same Hedera testnet, same USDC, a facilitator chip402 did not write. Testnet play money; licenses here are not a commercial grant of rights.

Printwright's invoices name fee payer `0.0.7162784`, advertised by `https://api.testnet.blocky402.com` — not the default `x402.org` facilitator. Point chip402 at that sponsor, allow the host, and fetch a cheap model (0.20 USDC, under the 1 USDC per-request cap):

```bash
chip402 allow printwright.liftbyai.com
chip402 facilitator https://api.testnet.blocky402.com
chip402 fetch 'https://printwright.liftbyai.com/api/v1/models/24/download?license=commercial_unit'
```

That URL is [Slide-On Bag Sealer](https://printwright.liftbyai.com/models/bag-sealer). Browse the catalog for others; anything over 1 USDC is refused by the cap unless you raise it. `chip402 facilitator default` restores `https://x402.org/facilitator`.

## Agents

Agents talk to the daemon over its unix socket. Filesystem permissions are the
authorization, so there is no token to manage and nothing listening on a TCP port:

```bash
SOCK="$XDG_RUNTIME_DIR/chip402.sock"

curl -sS --unix-socket "$SOCK" http://chip402.local/status
curl -sS --unix-socket "$SOCK" http://chip402.local/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:4403/secret"}'
curl -sS --unix-socket "$SOCK" http://chip402.local/pause \
  -H 'content-type: application/json' \
  -d '{"paused":true}'
```

For an agent that cannot use a unix socket, TCP is opt-in and needs a bearer token:

```bash
chip402 token          # writes ~/.config/chip402/token, mode 600
chip402 config tcp on  # then restart the daemon

# Read the token into the shell, then hand curl the header from a file it reads on stdin.
# A command line is visible to every process running as you, through /proc — so the token
# never goes in one.
TOKEN=$(cat ~/.config/chip402/token)
printf 'header = "authorization: Bearer %s"\n' "$TOKEN" |
  curl -sS --config - http://127.0.0.1:4402/status
```

Over TCP the daemon validates the `Host` header and refuses any request carrying `Origin`
or `Sec-Fetch-*`, so a web page cannot drive it through DNS rebinding.

Right-click the bar icon to pause. `p` in the panel does the same.

## Remove

```bash
omarchy plugin remove chip402 --yes
# optional: wipe keys, config, and the SDK copy
rm -rf ~/.config/chip402 ~/.local/state/chip402 ~/.local/bin/chip402
```

Removal does not write to any other Omarchy config unless you previously enabled the widget — `plugin remove` takes the widget off the bar.

## How it works

1. An agent requests a URL.
2. If the server returns HTTP 402, chip402 reads `PAYMENT-REQUIRED`, picks `exact` on `hedera:testnet`, and checks the kill switch, host allowlist, per-request cap, and daily cap.
3. It builds a `TransferTransaction` whose `transactionId.accountId` is the fee payer advertised by the facilitator (discovered from `/supported`), signs with the local operator key, and retries with `PAYMENT-SIGNATURE`.
4. The facilitator co-signs and submits. Network fees are not paid by the operator.
5. The panel watches `~/.local/state/chip402/state.json` and appends a ledger row.

## The key, and who holds it

Nobody holds a passphrase, because there isn't one.

`chip402 setup` generates a Hedera ECDSA key and writes it to `~/.config/chip402/key`,
**mode 600, unencrypted**. A daemon that signs invoices while you are not watching cannot stop
to ask for a passphrase, so the key is protected by file permissions and by the spend caps
rather than by a secret you remember. `setup` says all of this out loud before it creates the
key, and the panel repeats it on the first setup step.

What follows from that:

- **Anything running as your user can read the file. So can root.** chip402 does not defend
  against code you have already run — the same is true of your SSH keys. What it defends
  against is an agent overspending, a browser reaching the daemon, and a seller being paid
  twice.
- **The caps bound the loss, not the key.** 10 USDC/day and 1 USDC per request by default,
  enforced before anything is signed, with a kill switch on the bar.
- **Treat the balance like a coat pocket.** Top it up from a real wallet; do not park savings
  in it. The plugin holds an *operator* account, not your wallet.
- **Revoking is `rm ~/.config/chip402/key`.** The funds stay on Hedera and nothing can move
  them without the key. chip402 refuses to start if the file is looser than 600, and redacts
  DER and PEM keys from its logs.

Config: `~/.config/chip402/config.json`. Nothing is written outside `~/.config/chip402` and
`~/.local/state/chip402`.

## Testnet only, on purpose

chip402 runs on Hedera **testnet**. The payments are real — real USDC moving between real
accounts, with each settlement confirmed against the mirror node rather than taken on the
seller's word — but the money is testnet money.

It has been proven against a seller it did not author. [Printwright](https://printwright.liftbyai.com)
is an independent x402 marketplace — [try it](#try-a-real-seller-printwright). Settlements go
through `api.testnet.blocky402.com` (fee payer `0.0.7162784`), not chip402's default facilitator.
These are the ones that already landed:

| What happened | Proof |
| --- | --- |
| 0.60 USDC — commercial licence, *Beaver Desk Mascot with Hat* | [`0.0.7162784@1787550243.004621353`](https://hashscan.io/testnet/transaction/0.0.7162784%401787550243.004621353) · certificate `pw-7a2587cc0345bc49fd3e70b3` |
| 0.20 USDC — *Bag Sealer* | [`0.0.7162784@1787550318.813448723`](https://hashscan.io/testnet/transaction/0.0.7162784%401787550318.813448723) |
| 0.25 USDC — *Cable Clip* | [`0.0.7162784@1787550330.669218212`](https://hashscan.io/testnet/transaction/0.0.7162784%401787550330.669218212) |
| A 2.90 USDC invoice **refused** by the per-request cap | `per_request_cap: Invoice 2900000 exceeds per-request cap 1000000` |

The mirror node shows the first as `0.0.10193689 -600000` / `0.0.9584959 +600000` on token
`0.0.429274`, `SUCCESS`. The refusal is the point as much as the payments are: chip402 declined
a real invoice from a real seller, silently, without asking anyone.

Mainnet is written and not armed:

```bash
$ chip402 network mainnet
hedera:mainnet is not enabled in this build (MAINNET_SHIPPED=false). chip402 ships testnet only.
```

The mainnet profile, the `/supported` fee-payer discovery, the facilitator API-key path and the
401/429 handling are all in place and unit-tested, and a test suite asserts the switch stays
shut. What has *not* happened is a single call to a mainnet facilitator's `/verify` or
`/settle`. Until that path has been exercised, a build that would sign against real money on
it is a build making a promise it has not kept, so `resolveNetwork` refuses the network
outright instead.

### Turning it on anyway

Flipping the switch is deliberately a source edit, not a setting, so nobody arrives on mainnet
by clicking something. If you want to run it there, understand that you are the first:

```bash
# 1. Arm the build
sed -i 's/export const MAINNET_SHIPPED = false;/export const MAINNET_SHIPPED = true;/' \
  ~/.config/omarchy/plugins/chip402/daemon/lib/networks.mjs

# 2. Point it at mainnet — facilitator https://api.blocky402.com, USDC 0.0.456858
chip402 network mainnet

# 3. A facilitator API key is required on mainnet; put it in the config
#    ~/.config/chip402/config.json -> "facilitatorApiKey": "b402_..."

# 4. Fund the operator with real HBAR (account creation + association) and real USDC
chip402 status
```

The mainnet profile ships tighter defaults than testnet — **1 USDC daily, 0.10 per request**,
and `*` wildcard hosts are refused outright. The fee payer is discovered from the
facilitator's `/supported` at runtime and never pinned, so a facilitator key rotation is
picked up rather than hardcoded.

What you are accepting by doing this: no mainnet facilitator has ever been asked by chip402 to
verify or settle a payment. The code paths are unit-tested against stubs. The network is not.

## Defaults

| Cap | Default |
| --- | --- |
| Daily | 10 USDC |
| Per request | 1 USDC |
| Allowed hosts | `127.0.0.1`, `localhost`, `[::1]` (named one at a time; `*` is refused on every network) |
| Network | Hedera testnet |
| Facilitator | `https://x402.org/facilitator` |

```bash
chip402 cap daily 0.5
chip402 cap request 0.01
chip402 allow api.example.com
chip402 facilitator https://api.testnet.blocky402.com
chip402 pause
chip402 resume
```

## Reading the history

The panel is a receipt book: the last few payments, one line counting what was not paid today,
and cap changes summarised beside the sliders that made them. Nothing is discarded — the daemon
retains the last 50 entries either way, and `chip402 log` prints them whole, with the reasons the
panel abbreviates and the transaction ids.

```bash
chip402 log                       # everything retained
chip402 log --kind denied         # only what was refused, with the full reason
chip402 log --kind audit          # cap changes, pauses, hosts allowed
chip402 log --since 6h --json     # for piping into jq
chip402 tail                      # the same, refreshing every 2s
```

## License

MIT. External dependency: [`@hashgraph/sdk`](https://www.npmjs.com/package/@hashgraph/sdk) (Apache-2.0), pinned to an exact version in `runtime/package.json` and to a full integrity-hashed graph in `runtime/package-lock.json`. The code is installed into `~/.local/state/chip402/runtime` rather than vendored inside the plugin tree; the daemon refuses to load it if that directory was installed from any other lockfile.
