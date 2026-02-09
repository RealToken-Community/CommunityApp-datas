#!/usr/bin/env node

/**
 * Fetches RMM (v2 and v3) borrows on Gnosis: for each user and each year,
 * takes 4 snapshots of the debt (end of each quarter) in XDAI/USDC value and calculates the average.
 * Output: ../data/realt_borrowers_gnosis.json (readable format).
 */

import { createPublicClient, http, parseAbiItem, parseAbi } from "viem";
import { gnosis } from "viem/chains";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  GNOSIS_RPC,
  RMM_POOL_ADDRESSES,
  YEAR_STARTS,
  GNOSIS_BLOCK_TIME,
  getSnapshotTimestampsForYear,
  SNAPSHOTS_PER_YEAR,
  DEBT_BASE_DECIMALS,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "realt_borrowers_gnosis.json");

const poolAbi = parseAbi([
  "function getUserAccountData(address user) view returns (uint256 totalCollateralBase, uint256 totalDebtBase, uint256 availableBorrowsBase, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
]);

const client = createPublicClient({
  chain: gnosis,
  transport: http(GNOSIS_RPC, { timeout: 90_000 }),
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function blockNumberForTimestamp(referenceBlock, referenceTimestamp, targetTimestamp) {
  const delta = targetTimestamp - referenceTimestamp;
  return referenceBlock + Math.floor(delta / GNOSIS_BLOCK_TIME);
}

async function getBorrowLogs(poolAddress, fromBlock, toBlock) {
  const logs = [];
  const chunk = 10_000;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    const batch = await client.getLogs({
      address: poolAddress,
      event: parseAbiItem(
        "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
      ),
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    logs.push(...batch);
    from = to + 1;
    await sleep(500);
  }
  return logs;
}

/** Retrieve debts from multiple (pool, user) at a given block via multicall. */
async function getDebtsAtBlock(calls, blockNumber) {
  if (calls.length === 0) return [];
  const results = await client.multicall({
    contracts: calls.map(({ pool, user }) => ({
      address: pool,
      abi: poolAbi,
      functionName: "getUserAccountData",
      args: [user],
    })),
    blockNumber: BigInt(blockNumber),
    allowFailure: true,
  });
  return results.map((r) =>
    r.status === "success" && r.result ? Number(r.result[1] ?? 0n) : 0
  );
}

async function main() {
  console.log("RMM Borrowers – retrieval by snapshots (4/year, XDAI/USDC value)…\n");

  const latestBlock = await client.getBlock();
  const latestBlockNumber = Number(latestBlock.number);
  const latestTimestamp = Number(latestBlock.timestamp);

  const yearRanges = [];
  let years = Object.keys(YEAR_STARTS).map(Number).sort((a, b) => a - b);
  if (process.env.YEARS) {
    const filter = process.env.YEARS.split(",").map((y) => parseInt(y.trim(), 10));
    years = years.filter((y) => filter.includes(y));
  }
  for (let i = 0; i < years.length; i++) {
    const year = years[i];
    const startTs = YEAR_STARTS[year];
    if (startTs > latestTimestamp) continue;
    const endTs =
      i < years.length - 1 ? YEAR_STARTS[years[i + 1]] - 1 : latestTimestamp;
    const fromBlock = blockNumberForTimestamp(
      latestBlockNumber,
      latestTimestamp,
      startTs
    );
    const toBlock =
      endTs >= latestTimestamp
        ? latestBlockNumber
        : blockNumberForTimestamp(latestBlockNumber, latestTimestamp, endTs);
    yearRanges.push({ year, fromBlock: Math.max(0, fromBlock), toBlock });
  }

  // 1) Collect all users (full address) by year via Borrow events
  const usersByYear = {};
  for (const { year } of yearRanges) {
    usersByYear[year] = new Set();
  }
  for (const { year, fromBlock, toBlock } of yearRanges) {
    for (const pool of RMM_POOL_ADDRESSES) {
      const logs = await getBorrowLogs(pool, fromBlock, toBlock);
      for (const log of logs) {
        const user = log.args?.onBehalfOf ?? log.args?.user;
        if (user) usersByYear[year].add(user);
      }
      console.log(`Year ${year}, pool ${pool.slice(0, 10)}… : ${logs.length} Borrow events`);
    }
  }

  // 2) For each year, blocks of 4 snapshots (end of each quarter)
  const snapshotBlocksByYear = {};
  for (const { year } of yearRanges) {
    const timestamps = getSnapshotTimestampsForYear(year);
    snapshotBlocksByYear[year] = timestamps.map((ts) =>
      blockNumberForTimestamp(latestBlockNumber, latestTimestamp, ts)
    ).map((b) => Math.max(0, Math.min(b, latestBlockNumber)));
  }

  // 3) For each year and each snapshot, retrieve the debt (totalDebtBase) by user and pool, then average
  const byYearUser = {};
  for (const { year } of yearRanges) {
    byYearUser[String(year)] = {};
  }

  const divisor = 10 ** DEBT_BASE_DECIMALS;

  for (const { year } of yearRanges) {
    const users = [...usersByYear[year]];
    if (users.length === 0) continue;
    const blocks = snapshotBlocksByYear[year];
    console.log(`Year ${year}: ${users.length} users, 4 snapshots (blocks ${blocks[0]} … ${blocks[3]})`);

    const debtByUser = {};
    for (const u of users) debtByUser[u] = [];

    for (let s = 0; s < SNAPSHOTS_PER_YEAR; s++) {
      const blockNumber = blocks[s];
      const calls = [];
      for (const user of users) {
        for (const pool of RMM_POOL_ADDRESSES) {
          calls.push({ pool, user });
        }
      }
      const debts = await getDebtsAtBlock(calls, blockNumber);
      let i = 0;
      for (const user of users) {
        let totalDebt = 0;
        for (const _pool of RMM_POOL_ADDRESSES) {
          totalDebt += debts[i++] ?? 0;
        }
        debtByUser[user].push(totalDebt);
      }
      await sleep(300);
    }

    for (const user of users) {
      const values = debtByUser[user];
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / SNAPSHOTS_PER_YEAR;
      const avgHuman = Math.round((avg / divisor) * 100) / 100;
      byYearUser[String(year)][user] = { average_borrowed: avgHuman };
    }
  }

  // 4) Assign a rank by year (1 = biggest borrower) and reorder
  for (const year of Object.keys(byYearUser)) {
    const entries = Object.entries(byYearUser[year])
      .sort((a, b) => b[1].average_borrowed - a[1].average_borrowed);
    const ranked = {};
    entries.forEach(([addr], index) => {
      ranked[addr] = { average_borrowed: entries[index][1].average_borrowed, rank: index + 1 };
    });
    byYearUser[year] = ranked;
  }

  const output = {
    realt_borrowers_gnosis: byYearUser,
  };

  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFile written: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
