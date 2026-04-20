/**
 * Configuration for fetching RMM (RealToken Money Market) data on Gnosis.
 */
export const GNOSIS_RPC =
  process.env.GNOSIS_RPC ||
  "https://rpc.gnosis.gateway.fm";

/**
 * Adresses des pools RMM sur Gnosis (même référence que liquidators).
 * Ces contrats émettent LiquidationCall et exposent getReservesList / getReserveData.
 * Ils n’émettent PAS Mint/Burn : ces événements viennent des VariableDebtToken (adresses obtenues
 * via getReserveData). On indexe Mint/Burn sur ces tokens pour reconstruire l’intérêt off-chain.
 * - v3 = RealT RMM v3: Pool Proxy.
 * - v2 = LendingPool (équivalent Pool Proxy v2 ; adresse via LendingPoolAddressesProvider.getLendingPool()).
 */
export const RMM_POOL_ADDRESSES = [
  "0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3", // RMM v3 – Pool Proxy
  "0x5B8D36De471880Ee21936f328AAB2383a280CB2A", // RMM v2 – LendingPool (équivalent Pool Proxy v2)
];

/**
 * Premier block où chaque pool existe (gnosisscan / blockscout).
 * Utilisé pour ne pas fetcher d’événements avant le déploiement du pool.
 */
export const POOL_DEPLOYMENT_BLOCKS = {
  "0x5b8d36de471880ee21936f328aab2383a280cb2a": 20206577, // v2 – 20 jan 2022
  "0xfb9b496519fca8473fba1af0850b6b8f476bfdb3": 24967872, // v3 – 14 déc 2022
};

/** Years to include (start of each year in Unix timestamp). */
export const YEAR_STARTS = {
  2022: 1640995200, // 2022-01-01 00:00:00 UTC
  2023: 1672531200, // 2023-01-01 00:00:00 UTC
  2024: 1704067200, // 2024-01-01 00:00:00 UTC
  2025: 1735689600, // 2025-01-01 00:00:00 UTC
  2026: 1767225600, // 2026-01-01 00:00:00 UTC
};

/** Average time between two blocks on Gnosis (~5 s). */
export const GNOSIS_BLOCK_TIME = 5;

/** Decimal of the base currency (Aave: 8). */
export const DEBT_BASE_DECIMALS = 8;

/** Reserve decimals (crypto/stablecoins uniquement; RealTokens exclus du calcul d’intérêts). */
export const RESERVE_DECIMALS = {
  "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d": 18,  // WXDAI
  "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83": 6,  // USDC
  "0x4ecaba5870353805a9f068101a40e0f32ed605c6": 6,  // USDT
  "0x6a023ccd1ff6f2045c3309768ead9e68f978f6e1": 18,  // WETH
  "0x8e5bbbb09ed1ebde8674cda39a0c169401db4252": 8,  // WBTC
};
