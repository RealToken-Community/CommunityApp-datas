/**
 * Configuration for fetching RMM (RealToken Money Market) liquidation data on Gnosis.
 * - RMM v3: Main pool (Aave-based).
 * - RMM v2: Add the pool address if available.
 */

/** Gnosis RPC. Override with GNOSIS_RPC env var. Gateway.fm is faster for getLogs than publicnode. */
export const GNOSIS_RPC =
  process.env.GNOSIS_RPC ||
  "https://rpc.gnosis.gateway.fm";

/**
 * RMM pool addresses on Gnosis (v2 and v3).
 * Équivalent du "Pool Proxy" par version ; LiquidationCall est émis par ces contrats (pas par le WETH Gateway 0x80Dc05…).
 */
export const RMM_POOL_ADDRESSES = [
  "0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3", // RMM v3 – RealT RMM v3: Pool Proxy
  "0x5B8D36De471880Ee21936f328AAB2383a280CB2A", // RMM v2 – LendingPool (équivalent Pool Proxy v2)
];

/** Start of each year (Unix timestamp). */
export const YEAR_STARTS = {
  2022: 1640995200, // 2022-01-01 00:00:00 UTC
  2023: 1672531200, // 2023-01-01 00:00:00 UTC
  2024: 1704067200, // 2024-01-01 00:00:00 UTC
  2025: 1735689600, // 2025-01-01 00:00:00 UTC
  2026: 1767225600, // 2026-01-01 00:00:00 UTC
};

/** Average time between two blocks on Gnosis (~5 s). */
export const GNOSIS_BLOCK_TIME = 5;
