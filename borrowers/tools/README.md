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

- **RMM v3**: Pool 0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3.
- **RMM v2**: LendingPool 0x5B8D36De471880Ee21936f328AAB2383a280CB2A (même adresse que pour les liquidations).

Optional environment variables:

- **GNOSIS_RPC**: Gnosis RPC URL (default: https://rpc.gnosis.gateway.fm). Pour l’historique 2022/2023, un RPC avec bon support des anciens blocs peut être nécessaire.
- **YEARS**: Limit to desired years (e.g., `YEARS=2025,2026`) for faster testing.

## Architecture (important)

Le **Pool / LendingPool** émet **LiquidationCall** mais **n’émet pas** les événements **Mint** et **Burn** des intérêts. Ces événements sont émis par les contrats **VariableDebtToken** (un par réserve). On reconstruit l’intérêt off-chain en indexant Mint/Burn sur ces tokens.

## Calculation

1. **getReservesList** + **getReserveData** sur le pool → liste des adresses **VariableDebtToken** par réserve.
2. **Mint** et **Burn** sur ces contrats VariableDebtToken → `balanceIncrease` = intérêt accru. **Interest** = somme des `balanceIncrease` par user sur l’année (en base).
- **interest_prorata** = user's share of total interest (0–1). **rank** = ranking by interest (1 = top payer).

If no variable debt tokens are found for a year (e.g. pool does not expose them), that year is skipped (no data). No fallback to snapshots or residual formula.

**Note** : Si 2022/2023 restent vides alors qu’il y a eu des liquidations v2, les debt tokens sont détectés au block actuel ; un RPC limité en état historique peut ne pas renvoyer les Mint/Burn pour ces années. Même adresse v2 (LendingPool) que pour les liquidations.

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
