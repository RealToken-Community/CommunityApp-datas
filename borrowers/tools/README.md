# Borrowers tool

Tool to generate the final data file for RMM (RealToken Money Market) borrowers on Gnosis, by user and by year (versions 2 and 3).

## Une seule commande

From `borrowers` :

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

GNOSIS_RPC: Gnosis RPC URL (default: https://gnosis.publicnode.com). F
or full history or fewer limits, use a dedicated RPC.

YEARS: Limit to desired years (e.g., YEARS=2025,2026) for faster testing.

## Calcul: 

4 snapshots per year per user (end of each quarter), value in XDAI/USDC, then average of these 4 values

RMM V3: OK
RMM V2: TODO

## Format 

- **average_borrowed**: average debt (XDAI/USDC) over 4 snapshots per user per year.
- **rank**: ranking by borrowed amount (1 = highest).

```
{
  "realt_borrowers_gnosis": {
    "2023": {
      "0x1234567890123456789012345678901234567890": { "average_borrowed": 1, "rank": 1 },
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd": { "average_borrowed": 0.42, "rank": 2 }
    },
    "2024": {
      "0x1234567890123456789012345678901234567890": { "average_borrowed": 0.67, "rank": 1 },
      "0x9999999999999999999999999999999999999999": { "average_borrowed": 0.25, "rank": 2 }
    },
    "2025": {
      "0x5678567856785678567856785678567856785678": { "average_borrowed": 1.25, "rank": 1 }
    }
  }
}
```

## Questions

- Should we plan for blacklists here too? (Blacklists are managed in the community budget distribution tool)

