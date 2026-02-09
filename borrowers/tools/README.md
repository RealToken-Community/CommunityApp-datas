# Borrowers tool

Tool to generate the final data file for RMM (RealToken Money Market) borrowers on Gnosis, by user and by year (versions 2 and 3).

## Run this tool

From `borrowers`:

```bash
npm install
GNOSIS_RPC=https://rpc.gnosis.gateway.fm YEARS=2025 npm run fetch
```

Execution time can be a bit long, proceed year by year...

Result in CommunityApp-datas/borrowers/data/realt_borrowers_gnosis.json

## Configuration

- RMM v3: Gnosis pool 0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3 (already configured).
- RMM v2: If you have the pool address, add it to config.js → RMM_POOL_ADDRESSES.

Optional environment variables:

GNOSIS_RPC: Gnosis RPC URL (default: https://gnosis.publicnode.com). For full history or fewer limits, use a dedicated RPC.

YEARS: Limit to desired years (e.g., YEARS=2025,2026) for faster testing.

## Calculation

**No quarterly sampling.** We compute **real interest** per user over the year:

- **2 snapshots**: debt at start of year and end of year (`getUserAccountData`).
- **Events** Borrow and Repay over the year to get flows (borrows / repayments).
- **Interest** = `debt_end - debt_start - (borrows - repayments)` (in base XDAI/USDC).

Then:

- **interest_prorata**: user's share of total interest (0 to 1).
- **rank**: ranking by interest (1 = top payer).

RMM V3: OK. RMM V2: TODO.

## Format

- **interest**: interest paid over the year (base XDAI/USDC).
- **interest_prorata**: share of total interest (0–1).
- **rank**: ranking by interest (1 = highest).
- **average_borrowed**: average of debt at start of year and debt at end of year, i.e. `(debt_start + debt_end) / 2` in base XDAI/USDC (exposure over the year, for reference only).

```json
{
  "realt_borrowers_gnosis": {
    "2025": {
      "0x...": { "average_borrowed": 1000, "interest": 45.2, "interest_prorata": 0.15, "rank": 1 },
      "0x...": { "average_borrowed": 500, "interest": 12.1, "interest_prorata": 0.04, "rank": 2 }
    }
  }
}
```

## Questions

- Should we plan for blacklists here too? (Blacklists are managed in the community budget distribution tool)
