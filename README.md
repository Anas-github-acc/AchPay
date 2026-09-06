<div align="center">
  <img src="apps/web/public/AchPay.svg" alt="AchPay Logo" width="110" height="110" />

  # AchPay

  **Agentic Commerce Hub for Secure AI Payments**

  I built a system that lets an AI shop on your behalf, but it can never overspend, get tricked, or hide what it did — every decision is logged and provable.
  
  <p align="center">
    <a href="#core-defense-layers"><strong>Defense in Depth</strong></a> •
    <a href="#quick-start"><strong>Quick Start</strong></a> •
    <a href="#mcp-protocol"><strong>MCP Protocol</strong></a> •
    <a href="#spending-policy"><strong>Spending Policy</strong></a> •
    <a href="#verification--testing"><strong>Verification</strong></a>
  </p>

  <p align="center">
    <img src="https://img.shields.io/badge/Node-%3E%3D20.0.0-black?style=flat-square" alt="Node version" />
    <img src="https://img.shields.io/badge/TypeScript-5.9-blue?style=flat-square" alt="TypeScript" />
    <img src="https://img.shields.io/badge/MCP-Compatible-8A2BE2?style=flat-square" alt="MCP Compatible" />
    <img src="https://img.shields.io/badge/Razorpay-AutoPay-0C2340?style=flat-square" alt="Razorpay AutoPay" />
    <img src="https://img.shields.io/badge/License-MIT-gray?style=flat-square" alt="License" />
  </p>
</div>

---

## Overview

Allowing your AI Agent to make payments on behalf of you is inherently risky. Traditional payment flows accept dynamic amounts from client code, leaving systems vulnerable to prompt injection, hallucinations, hallucinated prices, and runaway loops.

**AchPay** resolves this by enforcing strict separation between **agent intent** and **financial execution**:

- **Agents never touch prices or amounts.** The only handle an agent possesses is an expiring, catalog-backed `quote_id`.
- **Untrusted merchant text cannot execute instructions.** Product descriptions are isolated and withheld from decision paths.
- **Spending limits are hard constraints.** Policies evaluate deterministically without external network or database side effects.
- **Every state transition is verifiable.** All actions are recorded on an insert-only, cryptographic hash-chained audit ledger.

---

## Core Defense Layers

AchPay processes all agent transactions through six deterministic defense layers:

| Layer | Defense | Invariant |
| :--- | :--- | :--- |
| **1. Signed Quotes** | HMAC-SHA256 Catalog Quotes | Quotes are priced server-side and sealed with a 120s TTL. No endpoint or tool accepts an amount. |
| **2. Ingest Sanitiser** | Merchant Content Isolation | Product prose is treated as untrusted data, stripped from standard browse paths, and never interpolated into model directives. |
| **3. Policy Engine** | Pure-Function Evaluation | Deterministic evaluation of transaction limits, daily caps, velocity, and category denylists. Every decision emits an explicit `rule_id`. |
| **4. Database Idempotency** | Atomic Unique Constraints | `(mandate_id, quote_id)` enforces exactly-once charging inside Postgres transactions, neutralizing race conditions and agent retries. |
| **5. Human Gate** | Single-Use Approval Tokens | Out-of-bounds purchases gate automatically. Ephemeral approval links allow humans to authorize or deny without exposing keys to the agent. |
| **6. Hash-Chained Ledger** | Cryptographic Audit Chain | Append-only ledger where each entry commits to the SHA-256 hash of the previous row. Any tampering pinpoints the exact broken sequence. |

---

## Quick Start

### Prerequisites

- **Node.js** `>= 20.0.0` and **pnpm** `>= 9.0.0`
- **Docker Desktop** (PostgreSQL & Redis)
- **ngrok** *(optional, for live Razorpay webhook testing)*

### Installation

```bash
# Clone the repository
git clone https://github.com/Anas-github-acc/AchPay.git
cd AchPay

# Install dependencies
pnpm install

# Start local PostgreSQL (port 55432) and Redis (port 56379)
docker compose up -d

# Set up local environment
cp .env.example .env
```

### Run Services

Start the Fastify API (:3000), Next.js Dashboard (:3001), and Webhook Tunnel with a single command:

```bash
pnpm dev:all
```

> Run without ngrok tunnel: `pnpm dev:all --no-tunnel`

Open [http://localhost:3001](http://localhost:3001) to explore the audit ledger, mandate headroom, and the live security attack matrix.

---

## MCP Protocol

AchPay provides an MCP server implementing standard tools for Claude Desktop, Cursor, and custom agent runtimes. Tools communicate over **stdio** or authenticated **HTTP SSE**.

### Registered Agent Tools

- `search_products` — Search catalog items (SKU, title, price in integer paise, category). Excludes untrusted prose.
- `get_product_details` — Retrieve isolated product copy for a specific SKU.
- `get_quote` — Price a basket of `{ sku, qty }` items; returns a cryptographically signed, expiring `quote_id`.
- `create_checkout` — Submit a transaction using `quote_id` and `mandate_id`. Returns `charged`, `pending_approval`, or `denied`.
- `get_order_status` — Inspect asynchronous payment settlement or human approval status.
- `list_receipts` — Read settled transaction history directly from the ledger.

### Claude Desktop Integration

Add AchPay to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "achpay": {
      "command": "pnpm",
      "args": ["--dir", "/path/to/AchPay", "mcp"]
    }
  }
}
```

Or configure directly via CLI:

```bash
pnpm mcp:add
```

---

## Spending Policy

Spending boundaries are defined in `policy.yaml`. The policy engine executes purely over structured values with zero database or network dependencies:

```yaml
# Transaction caps (in integer paise: 100 paise = 1 INR)
per_txn_max_paise: 50000          # ₹500 max per transaction
daily_max_paise: 500000           # ₹5,000 rolling 24-hour limit
velocity_max_per_hour: 5          # Max 5 checkouts per hour

# Human gate threshold
gate_above_paise: 30000           # > ₹300 requires human confirmation

# Denied categories
category_denylist:
  - alcohol
  - tobacco

# Choice bounding against prompt manipulation
max_qty_per_sku: 3
max_line_items: 10
gate_if_price_above_category_median_multiple: 2.0
```

---

## Verification & Testing

AchPay ships with automated verification routines and an adversarial attack grid simulating hostile merchant feeds and prompt injection vectors:

```bash
# Run unit and integration tests
pnpm test

# Run adversarial attack grid (writes data/adversarial-results.json)
pnpm test:adversarial

# Walk the cryptographic hash chain and verify ledger integrity
pnpm verify:ledger

# Reclaim expired headroom allocations
pnpm reclaim
```

---

## License

MIT © [AchPay Contributors](LICENSE)
