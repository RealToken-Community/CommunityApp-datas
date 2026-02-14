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

- Uses pool liquidation events (e.g. `LiquidationCall` on Aave/RMM v3).
- For each year: sum **liquidated amount** per address (liquidator).
- **amount**: total amount liquidated over the year (in base, e.g. USDC/XDAI).
- **amount_prorata**: liquidator's share of total liquidations for the year (0–1).
- **rank**: ranking by liquidated amount (1 = top liquidator).

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
