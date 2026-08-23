# Allowance — build notes (verified 2026-08-23)

Omarchy plugin: metered Hedera spending account for local AI agents, paying x402 invoices.
Competition deadline: Mon 24 Aug 09:00 CEST. Submit to github.com/HANCORE-linux/omarchy-plugin-marketplace

## Verified facts
- Plugin = git repo + manifest.json at root, QML loaded into the long-lived `omarchy-shell`
  (Quickshell). kinds: bar-widget|panel|overlay|menu|service|bar. Installed via
  `omarchy plugin add <git-url>` -> ~/.config/omarchy/plugins/<id>/
- Validator (`omarchy-plugin-validate`): schemaVersion must be number 1; required id/name/
  version/kinds/entryPoints; id !~ ^omarchy\.; entry points relative, no "..", must exist;
  each declared kind needs its entryPoints key; NO SYMLINKS anywhere in the plugin folder.
- Reuse `qs.Ui` (Panel, BarWidget, PanelSlider, Toggle, ConfirmDialog, PanelSectionHeader...)
  and `qs.Commons` (Color, Style). Best idiom reference: /usr/share/omarchy/shell/plugins/
  panels/tailscale/{Panel,Service}.qml + agents/Panel.qml
- x402 on Hedera is LIVE. `curl https://x402.org/facilitator/supported` returns:
    {"x402Version":2,"scheme":"exact","network":"hedera:testnet","extra":{"feePayer":"0.0.9185802"}}
- Hedera exact scheme: client builds TransferTransaction with
  transactionId.accountId == extra.feePayer, signs (partially), base64(toBytes()) into
  PaymentPayload.payload.transaction. Facilitator adds fee-payer sig + submits.
  Spec: github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_hedera.md
- v2 headers: PAYMENT-REQUIRED (S->C), PAYMENT-SIGNATURE (C->S), PAYMENT-RESPONSE (S->C),
  all base64 JSON. Support v1 `X-PAYMENT` + JSON body `accepts` as fallback.
- Tokens: HBAR = asset "0.0.0" (tinybars); USDC testnet = 0.0.429274 (6dp).
- Offline tx build CONFIRMED working with @hashgraph/sdk 2.81:
  setTransactionId(TransactionId.generate(feePayer)).setNodeAccountIds([0.0.3]).freeze().sign(key)
  -> 264-char base64. No network needed to sign.
- Runtime deps live OUTSIDE the plugin dir at ~/.local/state/omarchy-allowance/runtime
  (npm i @hashgraph/sdk = 232MB; keeps plugin repo symlink-free for the validator).

## Layout
  manifest.json  Panel.qml  Service.qml  Model.js  assets/
  daemon/allowanced.mjs (+lib/{hedera,x402,policy,state}.mjs)   127.0.0.1:4402
  demo/seller.mjs   tiny hedera:testnet x402 seller so the demo is self-contained
  bin/allowance     CLI: status | fetch <url> | fund | tail

## Config / state
  ~/.config/omarchy-allowance/config.json   network, accountId, caps, host allowlist
  ~/.config/omarchy-allowance/key           0600, refuse to start if looser
  ~/.local/state/omarchy-allowance/state.json  balances + ledger; QML FileView watches it

## Open
- Need Hedera testnet accountId + DER key from portal.hedera.com
- MCP stdio server (`pay_and_fetch` tool) so Claude Code can spend directly — high value, cheap
