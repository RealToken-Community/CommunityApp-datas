#!/usr/bin/env node

/**
 * RMM borrowers on Gnosis: per user per year we output interest, interest_prorata, and rank only.
 *
 * We only use variable debt tokens (mint/burn + index and balance): getReservesList + getReserveData,
 * then Mint/Burn events on the debt tokens; interest = sum of balanceIncrease per user.
 * No pool snapshots (getUserAccountData) and no residual formula.
 *
 * If no debt tokens are found for a year, that year is skipped (no data).
 * Output: ../data/realt_borrowers_gnosis.json
 */

import { createPublicClient, http, parseAbiItem, parseAbi } from "viem";
import { gnosis } from "viem/chains";
import { writeFileSync, mkdirSync, readFileSync } from "fs";
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

const poolReserveAbi = JSON.parse(
  readFileSync(join(__dirname, "pool-reserve-abi.json"), "utf8")
);

// Mint/Burn on variable debt tokens expose balanceIncrease (accrued interest)
const debtTokenMintEvent = parseAbiItem(
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 amountToMint, uint256 balanceIncrease, uint256 index)"
);
const debtTokenBurnEvent = parseAbiItem(
  "event Burn(address indexed from, address indexed target, uint256 amountToBurn, uint256 balanceIncrease, uint256 index)"
);

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

async function getLogs(addressOrAddresses, event, fromBlock, toBlock) {
  const logs = [];
  const chunk = 500_000;
  let from = fromBlock;
  const addresses = Array.isArray(addressOrAddresses) ? addressOrAddresses : [addressOrAddresses];
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    const batch = await client.getLogs({
      address: addresses.length === 1 ? addresses[0] : addresses,
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

/** Returns for each pool: list of { reserve, variableDebtTokenAddress } (debt token can be zero if not set). */
async function getReservesAndDebtTokens(blockNumber) {
  const out = [];
  for (const pool of RMM_POOL_ADDRESSES) {
    let reservesList = [];
    try {
      reservesList = await client.readContract({
        address: pool,
        abi: poolReserveAbi,
        functionName: "getReservesList",
        blockNumber: BigInt(blockNumber),
      });
    } catch (e) {
      console.warn(`getReservesList failed for pool ${pool.slice(0, 10)}…:`, e?.message || e);
      continue;
    }
    for (const reserve of reservesList || []) {
      try {
        const data = await client.readContract({
          address: pool,
          abi: poolReserveAbi,
          functionName: "getReserveData",
          args: [reserve],
          blockNumber: BigInt(blockNumber),
        });
        const variableDebtTokenAddress = data?.variableDebtTokenAddress ?? data?.[10];
        if (variableDebtTokenAddress && variableDebtTokenAddress !== "0x0000000000000000000000000000000000000000") {
          out.push({ pool, reserve, variableDebtTokenAddress });
        }
      } catch (e) {
        // skip this reserve
      }
    }
  }
  return out;
}

async function main() {
  console.log("RMM Borrowers – interest per user per year (debt token Mint/Burn only), prorata + rank…\n");

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

  const divisor = 10 ** BASE_DECIMALS;
  const byYearUser = {};
  for (const { year } of yearRanges) byYearUser[String(year)] = {};

  for (const { year, fromBlock, toBlock } of yearRanges) {
    const reserveDebtTokens = await getReservesAndDebtTokens(toBlock);
    if (reserveDebtTokens.length === 0) {
      console.log(`Year ${year}: no variable debt tokens found (getReservesList/getReserveData); skipping (no snapshots).`);
      continue;
    }

    const debtTokenToReserve = {};
    for (const { reserve, variableDebtTokenAddress } of reserveDebtTokens) {
      debtTokenToReserve[variableDebtTokenAddress.toLowerCase()] = reserve;
    }
    const debtTokenAddresses = reserveDebtTokens.map((r) => r.variableDebtTokenAddress);
    const [mintLogs, burnLogs] = await Promise.all([
      getLogs(debtTokenAddresses, debtTokenMintEvent, fromBlock, toBlock),
      getLogs(debtTokenAddresses, debtTokenBurnEvent, fromBlock, toBlock),
    ]);

    const users = new Set();
    const interestFromDebtTokenByUser = {};
    for (const log of mintLogs) {
      const user = log.args?.onBehalfOf;
      if (!user) continue;
      const reserve = debtTokenToReserve[log.address?.toLowerCase()];
      if (reserve == null) continue;
      const balanceIncrease = log.args?.balanceIncrease ?? log.args?.[3];
      if (balanceIncrease != null && balanceIncrease > 0n) {
        users.add(user);
        if (!interestFromDebtTokenByUser[user]) interestFromDebtTokenByUser[user] = 0;
        interestFromDebtTokenByUser[user] += reserveAmountToBase(balanceIncrease, reserve);
      }
    }
    for (const log of burnLogs) {
      const user = log.args?.from;
      if (!user) continue;
      const reserve = debtTokenToReserve[log.address?.toLowerCase()];
      if (reserve == null) continue;
      const balanceIncrease = log.args?.balanceIncrease ?? log.args?.[3];
      if (balanceIncrease != null && balanceIncrease > 0n) {
        users.add(user);
        if (!interestFromDebtTokenByUser[user]) interestFromDebtTokenByUser[user] = 0;
        interestFromDebtTokenByUser[user] += reserveAmountToBase(balanceIncrease, reserve);
      }
    }

    console.log(`Year ${year}, debt tokens: ${debtTokenAddresses.length}, Mint ${mintLogs.length}, Burn ${burnLogs.length}`);

    const userList = [...users];
    if (userList.length === 0) continue;

    for (const user of userList) {
      const interestBase = Math.round(interestFromDebtTokenByUser[user] ?? 0);
      const interestHuman = Math.round((interestBase / divisor) * 100) / 100;
      byYearUser[String(year)][user] = { interest: interestHuman };
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
    withProrata.forEach(({ addr, interest, interest_prorata }, index) => {
      ranked[addr] = { interest, interest_prorata, rank: index + 1 };
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
