# Allowance

A spend-capped wallet for local AI agents, living in the Omarchy bar.

Agents can pay [x402](https://x402.org) invoices on Hedera testnet. You set a daily cap and a per-request cap. One switch on the bar pauses every payment. HashPack (or the Hedera faucet) tops the account up; the plugin only holds a local **operator** key that cannot spend past the cap.

This is not a general-purpose wallet. It is an allowance.

![Allowance panel](preview.png)

![Kill switch](assets/demo.gif)

## What you get

- Bar icon that greys out when paused and badges when the operator is unfunded
- Panel with balance, today's spend, caps, and a live ledger (HashScan links)
- Kill switch: the hero toggle. Off means nothing signs, even if an agent retries
- Local daemon on `127.0.0.1:4402` so Claude Code / curl / any agent can pay
- Host allowlist (localhost only, until you opt in)
- Key file mode `600`, refused at start if looser

## Install

Needs Node.js 22+ and `npm`. The Hedera SDK is installed **outside** the plugin directory (the Omarchy validator forbids symlinks, and the SDK is large).

```bash
# from this checkout (until the GitHub repo is published)
omarchy plugin add /home/niko/Work/omarchy-allowance --enable --yes

# one-time runtime + operator key
~/.config/omarchy/plugins/nikodem.allowance/bin/allowance setup --watch
```

`setup` prints an EVM address. Fund it with testnet HBAR:

1. [Hedera testnet faucet](https://portal.hedera.com/faucet), or
2. HashPack, send testnet HBAR to that address

Then add the widget if the installer did not: `omarchy plugin enable nikodem.allowance`.

Optional PATH helper:

```bash
mkdir -p ~/.local/bin
ln -sf ~/.config/omarchy/plugins/nikodem.allowance/bin/allowance ~/.local/bin/allowance
```

## Pay something

In one terminal:

```bash
allowance demo          # x402 seller on :4403, 1000 tinybars per request
```

In another:

```bash
allowance fetch http://127.0.0.1:4403/secret
```

The panel ledger should show the settlement. Click a row to open it on HashScan.

Agents talk to the daemon directly:

```bash
curl -sS http://127.0.0.1:4402/status
curl -sS -X POST http://127.0.0.1:4402/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:4403/secret"}'
curl -sS -X POST http://127.0.0.1:4402/pause \
  -H 'content-type: application/json' \
  -d '{"paused":true}'
```

Right-click the bar icon to pause. `p` in the panel does the same.

## Remove

```bash
omarchy plugin remove nikodem.allowance --yes
# optional: wipe keys, config, and the SDK copy
rm -rf ~/.config/omarchy-allowance ~/.local/state/omarchy-allowance ~/.local/bin/allowance
```

Removal does not write to any other Omarchy config unless you previously enabled the widget — `plugin remove` takes the widget off the bar.

## How it works

1. An agent requests a URL.
2. If the server returns HTTP 402, Allowance reads `PAYMENT-REQUIRED`, picks `exact` on `hedera:testnet`, and checks the kill switch, host allowlist, per-request cap, and daily cap.
3. It builds a `TransferTransaction` whose `transactionId.accountId` is the x402 facilitator fee-payer (`0.0.9185802`), signs with the local operator key, and retries with `PAYMENT-SIGNATURE`.
4. The facilitator co-signs and submits. Network fees are not paid by the operator.
5. The panel watches `~/.local/state/omarchy-allowance/state.json` and appends a ledger row.

Operator key: `~/.config/omarchy-allowance/key` (ECDSA, DER, mode 600).
Config: `~/.config/omarchy-allowance/config.json`.

## Defaults

| Cap | Default |
| --- | --- |
| Daily | 1 HBAR |
| Per request | 0.1 HBAR |
| Allowed hosts | `127.0.0.1`, `localhost`, `[::1]` |
| Network | Hedera testnet |
| Facilitator | `https://x402.org/facilitator` |

```bash
allowance cap daily 0.5
allowance cap request 0.01
allowance allow api.example.com
allowance pause
allowance resume
```

## License

MIT. External dependency: [`@hashgraph/sdk`](https://www.npmjs.com/package/@hashgraph/sdk) (Apache-2.0), installed into `~/.local/state/omarchy-allowance/runtime` and never vendored inside the plugin tree.
