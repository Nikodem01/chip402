<p align="center">
  <img src="assets/brand-lockup.svg" width="300" alt="chip402 — agentic commerce purse">
</p>

<p align="center">
  An Omarchy OS plugin enabling safe agentic commerce through spend-capped x402 payments on Hedera.
</p>

<p align="center">
  <a href="https://hedera.com/"><img alt="Hedera — HBAR & USDC" src="https://img.shields.io/badge/Hedera-HBAR%20%7C%20USDC-00F5D4?style=flat-square"></a>
  <a href="https://docs.x402.org/"><img alt="Standard — x402 v2" src="https://img.shields.io/badge/Standard-x402%20v2-8A2BE2?style=flat-square"></a>
  <a href="https://github.com/Nikodem01/chip402"><img alt="Security — TPM2 Sealed | UID Isolated" src="https://img.shields.io/badge/Security-TPM2%20Sealed%20%7C%20UID%20Isolated-10B981?style=flat-square"></a>
  <a href="https://omarchy.org/"><img alt="Platform — Arch | Omarchy | Linux" src="https://img.shields.io/badge/Platform-Arch%20%7C%20Omarchy%20%7C%20Linux-orange?style=flat-square"></a>
  <a href="LICENSE"><img alt="License — MIT" src="https://img.shields.io/badge/License-MIT-blue?style=flat-square"></a>
</p>

<p align="center">
  <a href="#features"><strong>Features</strong></a> ·
  <a href="#quickstart"><strong>Quickstart</strong></a> ·
  <a href="#agent-usage-mcp"><strong>Agent usage</strong></a> ·
  <a href="#cli-reference"><strong>CLI</strong></a> ·
  <a href="#security-architecture"><strong>Security</strong></a> ·
  <a href="#the-code"><strong>The code</strong></a>
</p>

<p align="center">
  <img src="assets/demo.gif" width="100%" alt="chip402 Omarchy status bar widget and interactive Quickshell panel" />
</p>

---

## ✨ Features

- **Autonomous Micro-Payments**: Automatically pays HTTP `402 Payment Required` endpoints via [x402](https://docs.x402.org) on Hedera (HBAR & USDC) without human confirmation prompts.
- **Hardware-Sealed Key Isolation**: Private keys are sealed with TPM2 into root-owned memory under a dedicated `chip402` system user; AI agents never touch raw key material.
- **Strict Spending Bounds**: Enforces hard per-request maximums and daily allowance ceilings atomically before signing.
- **Instant Kill Switch**: Pause all outgoing payments instantly from shell, status bar, or agent without root permissions; resuming requires root authentication.
- **Omarchy Desktop Integration**: Status bar widget and Quickshell panel showing real-time balances, daily allowance meters, and live settlement receipts.
- **Native MCP Support**: Two-tool stdio server for Claude Desktop, Gemini, Cursor, and custom agent loops.

---

## 📦 Quickstart

### 1. Install

Requires Arch Linux / Omarchy and Node.js 26.7.0+ from the distro (`pacman -S nodejs npm`).

The bar widget is unprivileged — a copy in your plugin directory that can pause and read. The installer is root because it creates a system user that holds the key; agents never get that uid.

```bash
git clone https://github.com/Nikodem01/chip402
cd chip402
git checkout v0.1.0
sudo ./install.sh
```

`install.sh` provisions the `chip402` system user, installs verified dependencies (`npm ci --ignore-scripts --omit=dev`) as the invoking user, registers systemd services, installs the four polkit actions, configures sudo rules, and copies the Omarchy bar widget.

### Uninstall

```bash
sudo ./install.sh uninstall
```

Removes the system user, group, daemon, sudoers drop-in, polkit actions, plugin copy, and the TPM-sealed key. The Hedera account remains on chain; this machine will no longer hold the key. Log out for the group change to finish.

### 2. Setup & Arm

```bash
# Generate key, seal to TPM2, and complete testnet account
sudo chip402ctl setup

# Start the background daemon
sudo systemctl start chip402

# Enable the desktop status bar widget
omarchy plugin enable chip402 && omarchy restart shell

# Set spending limits & arm the purse
sudo chip402ctl allowance usdc 5.00   # $5.00 daily allowance
sudo chip402ctl max usdc 0.25         # $0.25 max per request
sudo chip402ctl resume
```

---

## 🤖 Agent Usage (MCP)

Add `chip402` to your MCP client configuration (e.g. `~/.config/claude/claude_desktop_config.json` or Cursor):

```json
{
  "mcpServers": {
    "chip402": {
      "command": "node",
      "args": ["/usr/local/lib/chip402/bin/mcp.ts"]
    }
  }
}
```

### Tools exposed to agents

| Tool | Parameters | Description |
| :--- | :--- | :--- |
| **`pay`** | `url` (string), `method?` (string), `body?` (string) | Fetches the resource, automatically signing and settling `402 Payment Required` responses within policy limits. Returns response bytes in an isolated block. |
| **`purse`** | _none_ | Returns remaining daily allowance, account balance, and recent settlements. Read-only. |

---

## 💻 CLI Reference

### Unprivileged Spend Plane (`chip402`)

Executed by users or agents without `sudo`:

```bash
chip402                       # View current balances, daily spend, and recent payments
chip402 pay https://api...    # Fetch URL and settle 402 payment
chip402 pause                 # Instant kill switch — stops all spending immediately
```

### Privileged Control Plane (`sudo chip402ctl`)

Requires root or Polkit admin authentication:

```bash
sudo chip402ctl setup                 # Generate key, seal to TPM2, and fund account
sudo chip402ctl allowance usdc 5.00   # Set daily allowance ceiling
sudo chip402ctl max usdc 0.25        # Set per-request cap
sudo chip402ctl resume               # Unpause / arm the purse
```

### Test against local x402 seller

```bash
# Terminal 1: Run local test seller
node demo/seller.ts --pay-to 0.0.5005 --asset hbar --price 0.01

# Terminal 2: Pay local endpoint
chip402 pay http://127.0.0.1:4403/secret
```

---

## 🛡️ Security Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       AI Agent / User                       │
└──────────────────────────────┬──────────────────────────────┘
                               │
               /run/chip402/spend.sock (0660)
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    chip402 System Daemon                    │
│                                                             │
│  ┌─────────────────┐    ┌─────────────────┐                 │
│  │  src/policy.ts  │    │  src/wallet.ts  │                 │
│  │ (Limits / Caps) │───▶│(Guarded Signer) │                 │
│  └─────────────────┘    └────────┬────────┘                 │
└──────────────────────────────────┼──────────────────────────┘
                                   │
                     TPM2-Sealed Read-Only tmpfs
                                   │
                         ┌─────────▼─────────┐
                         │   Systemd Secret  │
                         │   (Hedera Key)    │
                         └───────────────────┘
```

1. **Hardware Key Isolation**: The signing key is held exclusively in memory by the `chip402` system daemon under a dedicated UID (`src/safe.ts`). Raw keys never exist in user environments or agent process memory.
2. **Socket Plane Separation**:
   - **Spend Plane** (`/run/chip402/spend.sock`, `0660`): Accessible to agents; exposes `pay`, `purse`, and `pause`.
   - **Control Plane** (`/run/chip402/admin.sock`, `0600`): Root-only; exposes `resume`, `allowance`, and `max`.
3. **Asymmetric Authorization**: Any process can pause the purse immediately (`chip402 pause`). Resuming or raising limits requires password-authenticated root access. All four polkit actions in `ui/chip402.policy` enforce `auth_admin`.
4. **Hostile Seller Defenses**:
   - Invoices above per-request cap or daily allowance are rejected by `src/policy.ts` before signing.
   - Invoices naming our account as `feePayer` or `payTo` are refused.
   - Returned seller bytes are wrapped in an isolated MCP block with a per-call nonce.

---

## 💻 The Code

Twelve core files, each with one job, each meant to be read aloud: 1,749 lines of code, 3,245 with
the comments.

| file | owns | code / total |
|---|---|---|
| `src/chain.ts` | Everything Hedera says, and the only place it is asked. Five facts, none of them ours | 257 / 498 |
| `src/daemon.ts` | Two listeners in one process. The plane is the listener. The reading loop that mostly does not run | 259 / 451 |
| `src/fetch.ts` | The hardened fetch handed to the SDK — a hostile seller is the normal case | 83 / 132 |
| `src/ids.ts` | What a Hedera account id and a transaction id look like, in one place | 6 / 25 |
| `src/labels.ts` | The one thing chip402 knows that the chain cannot: which host an account id was reached at. Append-only, capped at 100,000 | 67 / 150 |
| `src/money.ts` | Decimal strings to base units and back, without a float anywhere | 36 / 61 |
| `src/networks.ts` | Two networks, two assets each. The mainnet switch, in one place | 81 / 118 |
| `src/policy.ts` | **Pure.** The whole decision on one screen: no I/O, no clock of its own, no path to the key. Also local midnight, the one thing about "today" that is ours | 85 / 191 |
| `src/protocol.ts` | The two verb sets, and the line-framed socket protocol | 80 / 132 |
| `src/purse.ts` | The limits, the kill switch, the day's figure, and the payments still in the air | 377 / 743 |
| `src/safe.ts` | File operations that have to be paranoid, and the two opposite contracts they come in | 107 / 199 |
| `src/wallet.ts` | **The guarded signer** — the enforcement point, the only `createClientHederaSigner` in `src/`, and the settlement chase | 311 / 545 |

- **Entry points**: `bin/chip402.ts` (spend CLI), `bin/chip402ctl.ts` (admin CLI), `bin/chip402ctl.sh` (the root-owned wrapper copied to `/usr/local/bin/chip402ctl`), `bin/mcp.ts` (agent tools).
- **Desktop UI**: `ui/Chip.qml` (status widget), `ui/Purse.qml` (panel), `ui/ChipIcon.qml` (icon), `ui/manifest.json`, and `ui/chip402.policy`.
- **Labels Store**: Local host mappings in `labels.jsonl` are kept generously (100,000 rows) and capped at 100,000 to prevent unbounded growth without touching spending policy.

---

## 🧪 Tests

```bash
npm test
```

All 237 unit and integration tests run offline against an in-process Hedera mirror node:

- `test/policy.test.ts`: Decision table verification and cross-asset rules.
- `test/signer.test.ts`: Key isolation, refusal guarantees, and signature safety.
- `test/purse.test.ts`: Limit tracking, in-flight concurrency, and atomic commit semantics.
- `test/daemon.test.ts`: Concurrency stress tests, restart attacks, and idle resource benchmarks.
- `test/planes.test.ts`: Unix socket privilege separation and Polkit authorization rules.
- `test/mcp.test.ts`: Out-of-process MCP agent integration and prompt injection boundaries.
- `test/readme.test.ts`: Automated consistency checks verifying README assertions against codebase metrics.
- `test/install.test.ts`: Installer privilege, provenance, uninstall, and README pin checks.

---

## 📄 License

MIT. See `LICENSE`.
