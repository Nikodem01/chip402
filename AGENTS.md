# Agent notes — chip402

Omarchy plugin: spend-capped Hedera operator for local agents paying x402 invoices.
Repo: `/home/niko/Work/chip402`. Plugin id `chip402`.

Do **not** open a GitHub repo, marketplace issue, or PR unless Nikodem explicitly asks.

## Hedera Docs MCP (required)

Official docs MCP is configured for Grok at user scope:

```toml
# ~/.grok/config.toml
[mcp_servers.hedera-docs]
url = "https://docs.hedera.com/mcp"
enabled = true
```

Remote HTTP, hosted by Mintlify. Read-only except `submit_feedback`. Prefer it over training data and over generic web search for anything Hedera (accounts, keys, aliases, HBAR units, SDK, mirror node, x402-on-Hedera).

If this session has no Hedera tools, they were added after the session started. Tell the user to restart Grok / press `r` in `/mcps`, or run `grok mcp doctor hedera-docs`.

### Tools

Discover with `search_tool` (`query`: `hedera-docs` or `search_hedera`). Call with `use_tool` using the **qualified** name:

| Tool | Use for |
| --- | --- |
| `hedera-docs__search_hedera` | Conceptual / “how do I…” queries. Input: `{ "query": "…" }`. Returns titles + doc paths. |
| `hedera-docs__query_docs_filesystem_hedera` | Read a page or grep the docs tree. Input: `{ "command": "…" }` against a **virtual** docs filesystem (not the user’s machine). |
| `hedera-docs__submit_feedback` | Only if a docs page is wrong/outdated. Input: `{ "path": "/…", "feedback": "…" }`. Not for product support. |

There is no separate “get page” tool. Search, then read.

### Workflow

1. `search_hedera` with a specific query (`ECDSA account alias auto create testnet faucet`, `TransferTransaction fee payer`, `mirror node accounts evm address`).
2. Take a hit path (e.g. `/learn/core-concepts/accounts/auto-account-creation`) and read it:
   - `query_docs_filesystem_hedera` `{ "command": "head -120 /learn/core-concepts/accounts/auto-account-creation.mdx" }`
   - Paths from search are URL paths; append `.mdx` for the filesystem.
3. Cite the docs URL: `https://docs.hedera.com` + path without `.mdx`.
4. Batch reads: `head -80 /a.mdx /b.mdx`. Output is capped (~30KB). Prefer `rg -C 3 "pattern" /path` over `cat` of huge files.
5. Structural look: `tree / -L 2` or `rg -il "x402" /`.

Do **not** use this MCP to sign, submit, or mutate network state. It only searches published docs.

### Hedera facts this plugin depends on (still verify in MCP)

- Account IDs are `0.0.n`, assigned when the account is created. Until first HBAR, we only have an **EVM alias** (`0x…`) derived from an ECDSA secp256k1 key.
- Faucet / HashPack send HBAR to that `0x…` alias → Hedera auto-creates `0.0.n`. Daemon polls mirror node and fills `accountId`.
- x402 `exact` on `hedera:testnet` wants `0.0.n` in `payTo` / `extra.feePayer`, not the `0x` alias. Facilitator fee-payer is `0.0.9185802`.
- Spend asset is USDC testnet `0.0.429274` (6 decimals). An account with `max_automatic_token_associations` of `-1` (the default for auto-created and completed-hollow accounts) needs **no** explicit association — an unconditional `TokenAssociateTransaction` costs ~0.63 HBAR and is charged even when it comes back `TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT`. x402 transfers themselves are facilitator-sponsored.
- HBAR sent to an EVM alias auto-creates a **hollow** account: an id and an alias, `"key": null` on the mirror node, and no signing key. The facilitator looks that key up and rejects every payment from it. One self-paid, self-signed transaction completes it; a fee-only `TransferTransaction` is the cheapest vehicle (~127k tinybar).
- HBAR is always singular uppercase. Networks: `mainnet` / `testnet` / `previewnet` lowercase.
- JS SDK in this repo is `@hashgraph/sdk` in `~/.local/state/chip402/runtime` (outside the plugin tree; no symlinks). Newer namespace is `@hiero-ledger/sdk` — check docs before changing imports.

## Marketplace review (binding before any resubmission)

chip402 is listed at HANCORE-linux/omarchy-plugin-marketplace issue #2035. Two gates: a
deterministic scanner, then a human security review by `HANCORE-linux` that blocks commits
with "this exact SHA is not approvable". The scanner passing means nothing about the review.

Read the skill before touching the daemon, the panel or the setup path:
`~/.grok/skills/omarchy-marketplace-hardening/SKILL.md` (mirror:
`~/.claude/skills/omarchy-marketplace-hardening/`). It encodes ~70 maintainer reviews.

The premise: an Omarchy plugin is unsandboxed code inside a long-lived process, so every byte
from network, subprocess, disk, clipboard or compositor is attacker-controlled. Caps must be
**producer-side and fail-closed** (a check after the bytes are resident does not count) and
file access must be **descriptor-bound** (stat-then-open is a check-to-use window).

Six blocking classes — audit all six before replying to a review, not just the one named:

1. Unbounded input (byte cap + deadline + item cap on every response, stdout **and** stderr,
   file load and cache).
2. Predictable-path state: owner-only dir, `O_NOFOLLOW`, regular-file/owner/size on the
   descriptor, descriptor-relative atomic replace.
3. QML rich text: every non-literal `Text`/tooltip needs `textFormat: Text.PlainText`.
4. Supply chain: committed lockfile with hashes, frozen install, full-SHA pins.
5. Secrets never in argv or a child environment.
6. Privilege: argv over interpolated shell, allowlisted mutations.

State of the six classes in this tree — audit before changing any of it, and do not let an
item drift back:

1. Bounded input: `daemon/lib/http.mjs` streams every response under a byte cap with a
   deadline and refuses a body it cannot stream; item caps live in `policy.mjs`
   (`MAX_ACCEPTS`), `hedera.mjs` (`MAX_MIRROR_ROWS`), `x402.mjs` (response headers) and
   `Model.js` (`MAX_LEDGER_ROWS`); `chip402d.mjs` caps `/fetch` urls and every ledger field.
2. Files: `daemon/lib/safeio.mjs` is the only way state, keys, the token and the log are
   opened — `O_NOFOLLOW`, `fstat` on the descriptor, owner, type, size, mode at open.
   `CONFIG_DIR` and `STATE_DIR` are `0700`, re-tightened through their descriptors.
3. QML rich text: every `Text` in `Panel.qml` and `ChipIcon.qml` sets
   `textFormat: Text.PlainText`. Host components (`PanelHero`, `PanelToolTip`) cannot be set
   from here, so `Model.parseState` strips markup and control characters and clamps lengths at
   the boundary. Keep both halves.
4. Supply chain: `runtime/package.json` pins `@hashgraph/sdk` exactly, `runtime/package-lock.json`
   carries the integrity hashes, `ensureRuntime` installs with `npm ci --ignore-scripts` over
   argv, and `loadSdk` refuses a runtime directory installed from a different lockfile.
5. Secrets: keys and the bearer token are read through `readVerified` at mode 600; nothing
   goes in argv or a child environment. The README documents the TCP token over stdin.
6. Privilege: `Service.qml` launches argv only — no shell, no login shell. `openUrl` takes
   https and nothing else. `allow "*"` is refused on every network.

The panel reads state over the daemon's socket (`GET /status`), never off disk. If you are
tempted to reintroduce `FileView` on `state.json`, that is the shape the marketplace has
blocked at least seven times.

## Layout

```
manifest.json          bar-widget, id chip402
Panel.qml Service.qml Model.js ChipIcon.qml
daemon/chip402d.mjs  unix socket $XDG_RUNTIME_DIR/chip402.sock (mode 600); TCP is opt-in
daemon/lib/{hedera,x402,policy,state,safeio,networks,facilitator,client,sdk,paths,log}.mjs
runtime/{package.json,package-lock.json}  reviewed dependency graph, installed with npm ci
demo/seller.mjs        127.0.0.1:4403
bin/chip402          CLI
test/{e2e,accounting,transport,hardening,mainnet-switch}.test.mjs
```

Talk to the daemon with `curl --unix-socket "$XDG_RUNTIME_DIR/chip402.sock" http://chip402.local/status`.
QML cannot: `XMLHttpRequest` is TCP-only, so `Service.qml` runs curl as argv — no shell — and
applies the response body it gets back. That response is where the panel's state comes from.

Secrets live **outside** the repo:

- `~/.config/chip402/key` and `merchant-key` (mode 600; daemon refuses looser)
- `~/.config/chip402/config.json`
- `~/.local/state/chip402/state.json` (daemon only; the panel reads `GET /status` instead)

Never commit keys. Never `chmod` the key file to anything but 600.

## Local commands

```bash
omarchy plugin validate .
node --test daemon/lib/*.test.mjs Model.test.mjs test/*.test.mjs
./bin/chip402 status
./bin/chip402 setup --watch    # wait for faucet → accountId
./bin/chip402 demo             # seller
./bin/chip402 fetch http://127.0.0.1:4403/secret
```

Plugin is already installed from this checkout (`omarchy plugin add /home/niko/Work/chip402 --enable --yes`). After QML edits, the shell hot-reloads; if not: `omarchy-shell shell rescanPlugins`.
