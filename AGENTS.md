# Agent notes — chip402

Omarchy plugin: spend-capped Hedera operator for local agents paying x402 invoices.
Repo: `/home/niko/Work/omarchy-allowance`. Plugin id `nikodem.chip402`.

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
- HBAR is always singular uppercase; tinybars always plural lowercase. Networks: `mainnet` / `testnet` / `previewnet` lowercase.
- JS SDK in this repo is `@hashgraph/sdk` in `~/.local/state/chip402/runtime` (outside the plugin tree; no symlinks). Newer namespace is `@hiero-ledger/sdk` — check docs before changing imports.

## Layout

```
manifest.json          bar-widget, id nikodem.chip402
Panel.qml Service.qml Model.js ChipIcon.qml
daemon/chip402d.mjs  127.0.0.1:4402
daemon/lib/{hedera,x402,policy,state,sdk,paths,log}.mjs
demo/seller.mjs        127.0.0.1:4403
bin/chip402          CLI
```

Secrets live **outside** the repo:

- `~/.config/chip402/key` and `merchant-key` (mode 600; daemon refuses looser)
- `~/.config/chip402/config.json`
- `~/.local/state/chip402/state.json` (QML FileView)

Never commit keys. Never `chmod` the key file to anything but 600.

## Local commands

```bash
omarchy plugin validate .
node --test daemon/lib/*.test.mjs
./bin/chip402 status
./bin/chip402 setup --watch    # wait for faucet → accountId
./bin/chip402 demo             # seller
./bin/chip402 fetch http://127.0.0.1:4403/secret
```

Plugin is already installed from this checkout (`omarchy plugin add /home/niko/Work/omarchy-allowance --enable --yes`). After QML edits, the shell hot-reloads; if not: `omarchy-shell shell rescanPlugins`.
