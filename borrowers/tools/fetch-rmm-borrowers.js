#!/usr/bin/env node

/**
 * RMM borrowers on Gnosis: for each user and each year we compute real interest over the year
 * using 2 snapshots (start + end of year) and Borrow/Repay events:
 *   interest = debt_end - debt_start - (sum borrows - sum repays)
 * Then: prorata of total interest and rank by interest.
 * No quarterly sampling. Output: ../data/realt_borrowers_gnosis.json
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
  DEBT_BASE_DECIMALS,
  RESERVE_DECIMALS,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "realt_borrowers_gnosis.json");
const BASE_DECIMALS = DEBT_BASE_DECIMALS;

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

function reserveAmountToBase(amountWei, reserveAddress) {
  const dec = RESERVE_DECIMALS[reserveAddress?.toLowerCase()] ?? 18;
  if (dec >= BASE_DECIMALS) return Number(amountWei) / 10 ** (dec - BASE_DECIMALS);
  return Number(amountWei) * 10 ** (BASE_DECIMALS - dec);
}

async function getLogs(poolAddress, event, fromBlock, toBlock) {
  const logs = [];
  const chunk = 10_000;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    const batch = await client.getLogs({
      address: poolAddress,
      event,
      fromBlock: BigInt(from),
      toBlock: BigInt(to),
    });
    logs.push(...batch);
    from = to + 1;
    await sleep(500);
  }
  return logs;
}

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
  console.log("RMM Borrowers – interest per user per year (2 snapshots + Borrow/Repay), prorata + rank…\n");

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

  const borrowEvent = parseAbiItem(
    "event Borrow(address indexed reserve, address user, address indexed onBehalfOf, uint256 amount, uint8 interestRateMode, uint256 borrowRate, uint16 indexed referralCode)"
  );
  const repayEvent = parseAbiItem(
    "event Repay(address indexed reserve, address indexed user, address indexed repayer, uint256 amount, bool useATokens)"
  );

  const divisor = 10 ** BASE_DECIMALS;
  const byYearUser = {};
  for (const { year } of yearRanges) byYearUser[String(year)] = {};

  for (const { year, fromBlock, toBlock } of yearRanges) {
    const users = new Set();
    const netBorrowBaseByUser = {};

    for (const pool of RMM_POOL_ADDRESSES) {
      const [borrows, repays] = await Promise.all([
        getLogs(pool, borrowEvent, fromBlock, toBlock),
        getLogs(pool, repayEvent, fromBlock, toBlock),
      ]);
      for (const log of borrows) {
        const user = log.args?.onBehalfOf ?? log.args?.user;
        if (!user) continue;
        users.add(user);
        if (!netBorrowBaseByUser[user]) netBorrowBaseByUser[user] = 0;
        netBorrowBaseByUser[user] += reserveAmountToBase(log.args.amount, log.args.reserve);
      }
      for (const log of repays) {
        const user = log.args?.user;
        if (!user) continue;
        users.add(user);
        if (!netBorrowBaseByUser[user]) netBorrowBaseByUser[user] = 0;
        netBorrowBaseByUser[user] -= reserveAmountToBase(log.args.amount, log.args.reserve);
      }
      console.log(`Year ${year}, pool ${pool.slice(0, 10)}… : ${borrows.length} Borrow, ${repays.length} Repay`);
    }

    const userList = [...users];
    if (userList.length === 0) continue;

    const debtStartCalls = [];
    const debtEndCalls = [];
    for (const user of userList) {
      for (const pool of RMM_POOL_ADDRESSES) {
        debtStartCalls.push({ pool, user });
        debtEndCalls.push({ pool, user });
      }
    }
    const debtsStart = await getDebtsAtBlock(debtStartCalls, fromBlock);
    await sleep(300);
    const debtsEnd = await getDebtsAtBlock(debtEndCalls, toBlock);

    const poolsCount = RMM_POOL_ADDRESSES.length;
    let i = 0;
    for (const user of userList) {
      let debtStart = 0, debtEnd = 0;
      for (let p = 0; p < poolsCount; p++) {
        debtStart += debtsStart[i] ?? 0;
        debtEnd += debtsEnd[i] ?? 0;
        i++;
      }
      const netBorrow = netBorrowBaseByUser[user] ?? 0;
      let interestBase = debtEnd - debtStart - netBorrow;
      if (interestBase < 0) interestBase = 0;
      const interestHuman = Math.round((interestBase / divisor) * 100) / 100;
      const avgDebtHuman = Math.round(((debtStart + debtEnd) / 2 / divisor) * 100) / 100;
      byYearUser[String(year)][user] = { interest: interestHuman, average_borrowed: avgDebtHuman };
    }
  }

  for (const year of Object.keys(byYearUser)) {
    const entries = Object.entries(byYearUser[year]);
    const totalInterest = entries.reduce((acc, [, v]) => acc + (v.interest ?? 0), 0);
    const withProrata = entries.map(([addr, v]) => ({
      addr,
      ...v,
      interest_prorata: totalInterest > 0 ? Math.round((v.interest / totalInterest) * 10000) / 10000 : 0,
    }));
    withProrata.sort((a, b) => (b.interest ?? 0) - (a.interest ?? 0));

    const ranked = {};
    withProrata.forEach(({ addr, average_borrowed, interest, interest_prorata }, index) => {
      ranked[addr] = { average_borrowed, interest, interest_prorata, rank: index + 1 };
    });
    byYearUser[year] = ranked;
  }

  const output = { realt_borrowers_gnosis: byYearUser };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFile written: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
