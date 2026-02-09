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

- **GNOSIS_RPC**: Gnosis RPC URL (default: https://gnosis.publicnode.com). For full history or fewer limits, use a dedicated RPC.
- **YEARS**: Limit to desired years (e.g., `YEARS=2025,2026`) for faster testing.

## Calculation

- **getReservesList** + **getReserveData** on the pool → list of variable debt token addresses per reserve.
- **Mint** and **Burn** events on these tokens expose `balanceIncrease` (accrued interest). **Interest** = sum of `balanceIncrease` per user over the year (in base).
- **interest_prorata** = user's share of total interest (0–1). **rank** = ranking by interest (1 = top payer).

If no variable debt tokens are found for a year (e.g. pool does not expose them), that year is skipped (no data). No fallback to snapshots or residual formula.

RMM V3: OK. RMM V2: TODO?

## Format

- **interest**: interest paid over the year (base XDAI/USDC).
- **interest_prorata**: share of total interest (0–1).
- **rank**: ranking by interest (1 = highest).

```json
{
  "realt_borrowers_gnosis": {
    "2025": {
      "0x...": { "interest": 45.2, "interest_prorata": 0.15, "rank": 1 },
      "0x...": { "interest": 12.1, "interest_prorata": 0.04, "rank": 2 }
    }
  }
}
```

## Questions

- Should we plan for blacklists here too? (Blacklists are managed in the community budget distribution tool)
