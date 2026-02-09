/**
 * Configuration for fetching RMM (RealToken Money Market) data on Gnosis.
 * - RMM v3: Main pool (Aave-based).
 * - RMM v2: Add the pool address if available.
 */

export const GNOSIS_RPC =
  process.env.GNOSIS_RPC ||
  "https://gnosis.publicnode.com";

/** Adresses des pools RMM sur Gnosis (v2 et v3). */
export const RMM_POOL_ADDRESSES = [
  // RMM v3 - Main pool
  "0xFb9b496519fCa8473fba1af0850B6B8F476BFdB3",
  // RMM v2 - Uncomment and add the address if you have it
  // "0x..."
];

/** Years to include (start of each year in Unix timestamp). */
export const YEAR_STARTS = {
  2023: 1672531200, // 2023-01-01 00:00:00 UTC
  2024: 1704067200, // 2024-01-01 00:00:00 UTC
  2025: 1735689600, // 2025-01-01 00:00:00 UTC
  2026: 1767225600, // 2026-01-01 00:00:00 UTC
};

/** Average time between two blocks on Gnosis (~5 s). */
export const GNOSIS_BLOCK_TIME = 5;

/** Number of debt snapshots per year (end of each quarter). */
export const SNAPSHOTS_PER_YEAR = 4;

/** Quarter end timestamps (day at 12:00 UTC) : Mar 31, Jun 30, Sep 30, Dec 31. */
export function getSnapshotTimestampsForYear(year) {
  return [
    Date.UTC(year, 2, 31, 12, 0, 0) / 1000,  // 31 March
    Date.UTC(year, 5, 30, 12, 0, 0) / 1000,  // 30 June
    Date.UTC(year, 8, 30, 12, 0, 0) / 1000, // 30 September
    Date.UTC(year, 11, 31, 12, 0, 0) / 1000, // 31 December
  ];
}

/** Decimal of the base currency (Aave: 8). */
export const DEBT_BASE_DECIMALS = 8;

/** Reserve decimals on Gnosis (to convert event amounts to base). */
export const RESERVE_DECIMALS = {
  "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83": 6,   // USDC
  "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d": 18,  // WXDAI
};
