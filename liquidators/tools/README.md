# Liquidators tool

Tool to generate the data file for RMM (RealToken Money Market) **liquidators** on Gnosis, by address and by year (versions 2 and 3).

Goal: reward liquidations performed on RMM V2 and RMM V3. Data is aggregated **by year** and **by address**; we rank the best wallets (those that have liquidated the most amount).

## Run this tool

From the `liquidators` folder:

```bash
npm install
GNOSIS_RPC=https://rpc.gnosis.gateway.fm YEARS=2025 npm run fetch

npm run fetch
```

Result in `CommunityApp-datas/liquidators/data/realt_liquidators_gnosis.json`.

## Configuration

- **RMM v3**: Gnosis pool `0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3` (already in `config.js`).
- **RMM v2**: Add the pool address in `config.js` → `RMM_POOL_ADDRESSES`.

Optional environment variables:

- **GNOSIS_RPC**: Gnosis RPC URL (default: https://gnosis.publicnode.com).
- **YEARS**: Optional. Limit to desired years (e.g. `YEARS=2025,2026`) for faster testing. If unset, all years from config are processed.

## Calculation

- Uses pool liquidation events (`LiquidationCall`: **debtToCover**, **debtAsset**, liquidator).
- For each year: sum **liquidated amount** per address (liquidator).
- **amount**: total amount liquidated over the year (normalized to 8 decimals, then displayed).
- **amount_prorata**: liquidator's share of total liquidations for the year (0–1).
- **rank**: ranking by liquidated amount (1 = top liquidator).

### How the amount is computed (on-chain)

- **Source**: `debtToCover` = debt repaid (in wei) in the **debt token** (stablecoin or other).
- **Token**: `debtAsset` = address of the debt token (USDC, WXDAI, etc.). Only **USDC** and **WXDAI** have explicit decimals in the script; any other token (e.g. another stable or RealToken as debt) uses a default of **18 decimals**.
- **Normalization**: `debtToBase(amountWei, debtAsset)` converts to a common 8-decimal base so we can sum across events. Display = base / 10^8. So we are **not** converting to USD: we sum nominal amounts per token (1 USDC = 1, 1 WXDAI = 1 in display; other tokens scaled by their decimals).
- **Mock CSV**: uses the "Montant remboursé" / "Dette remboursée" column (human-readable amount in token units). Same notion as on-chain if the export is in token units.
- **Why real and mock can differ for the same year**: (1) Snapshot: mock may have been exported at a given date, so fewer events than the full on-chain history. (2) More events on-chain for that address in that year. (3) If the CSV export used a different unit (e.g. USD for some tokens), the scale would differ.

## Data format

- **amount**: total amount liquidated over the year (base).
- **amount_prorata**: share of total (0–1).
- **rank**: rank (1 = top liquidator).

Example: see `../data/exemple_data.json`.

```json
{
  "realt_liquidators_gnosis": {
    "2025": {
      "0x...": { "amount": 3200.75, "amount_prorata": 1.0, "rank": 1 },
      "0x...": { "amount": 800.2, "amount_prorata": 0.25, "rank": 2 }
    }
  }
}
```

## DATA verification 

- Gitbook documentation array : https://community-realt.gitbook.io/tuto-community/defi-realt/rmm/evaluation-du-delais-avant-liquidation
- Link subgrah RealT: https://thegraph.com/explorer/profile/0x1bcfe8666cbb7edd3eda5d343d5f2d4ce853b034?view=Subgraphs

Subgraph for RMM V2 is deprecated ?? 

## Methods 

V1 -> Use data onchain
V2 -> Use TheGraph // Why ? 

