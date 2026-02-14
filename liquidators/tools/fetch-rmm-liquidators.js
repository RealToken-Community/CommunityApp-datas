#!/usr/bin/env node

/**
 * RMM liquidators on Gnosis: per address per year we output amount, amount_prorata, rank.
 * Uses LiquidationCall events from Aave/RMM pools (v2 and v3).
 * Goal: reward liquidations; rank wallets by liquidated amount.
 * Output: ../data/realt_liquidators_gnosis.json
 */

import { createPublicClient, http, parseAbiItem } from "viem";
import { gnosis } from "viem/chains";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  GNOSIS_RPC,
  RMM_POOL_ADDRESSES,
  YEAR_STARTS,
  GNOSIS_BLOCK_TIME,
} from "./config.js";

const RESERVE_DECIMALS = {
  "0xddafbb505ad214d7b80b1f830fccc89b60fb7a83": 6,   // USDC
  "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d": 18,  // WXDAI
};
const BASE_DECIMALS = 8;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "realt_liquidators_gnosis.json");

const liquidationCallEvent = parseAbiItem(
  "event LiquidationCall(address indexed collateralAsset, address indexed debtAsset, address indexed user, uint256 debtToCover, uint256 liquidatedCollateralAmount, address liquidator, bool receiveAToken)"
);

// Large timeout for getLogs on big block ranges (public RPC can be slow on old blocks)
const RPC_TIMEOUT_MS = 180_000;

const client = createPublicClient({
  chain: gnosis,
  transport: http(GNOSIS_RPC, { timeout: RPC_TIMEOUT_MS }),
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function blockNumberForTimestamp(referenceBlock, referenceTimestamp, targetTimestamp) {
  const delta = targetTimestamp - referenceTimestamp;
  return referenceBlock + Math.floor(delta / GNOSIS_BLOCK_TIME);
}

function debtToBase(amountWei, debtAssetAddress) {
  const dec = RESERVE_DECIMALS[debtAssetAddress?.toLowerCase()] ?? 18;
  if (dec >= BASE_DECIMALS) return Number(amountWei) / 10 ** (dec - BASE_DECIMALS);
  return Number(amountWei) * 10 ** (BASE_DECIMALS - dec);
}

function isRetryableRpcError(err) {
  const msg = err?.message ?? err?.shortMessage ?? err?.details ?? "";
  const code = err?.code ?? err?.cause?.code;
  return (
    code === -32016 ||
    code === -32701 ||
    msg.includes("timeout") ||
    msg.includes("canceled") ||
    msg.includes("too many") ||
    msg.includes("maximum block range") ||
    msg.includes("exceed maximum")
  );
}

/** Fetch one block range; on timeout/size error, split in two and retry (recursive). */
async function fetchRangeWithRetry(addresses, event, fromBlock, toBlock, logLabel, minChunk = 10_000) {
  const size = toBlock - fromBlock + 1;
  try {
    const batch = await client.getLogs({
      address: addresses,
      event,
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
    console.log(`  [${logLabel}] blocks ${fromBlock}-${toBlock} (${batch.length} events)`);
    await sleep(300);
    return batch;
  } catch (err) {
    if (isRetryableRpcError(err) && size > minChunk) {
      const mid = fromBlock + Math.floor(size / 2);
      console.log(`  [${logLabel}] retry: splitting ${fromBlock}-${toBlock} into 2 chunks`);
      const [left, right] = await Promise.all([
        fetchRangeWithRetry(addresses, event, fromBlock, mid, logLabel, minChunk),
        fetchRangeWithRetry(addresses, event, mid + 1, toBlock, logLabel, minChunk),
      ]);
      return [...left, ...right];
    }
    throw err;
  }
}

async function getLogs(addresses, event, fromBlock, toBlock, logLabel = "") {
  const chunk = 100_000;
  const logs = [];
  let from = fromBlock;
  let chunkIndex = 0;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
    chunkIndex++;
    const batch = await fetchRangeWithRetry(addresses, event, from, to, logLabel, 10_000);
    logs.push(...batch);
    from = to + 1;
  }
  return logs;
}

async function main() {
  console.log("RMM Liquidators – liquidated amount per address per year (LiquidationCall), prorata + rank…\n");

  console.log("Fetching latest block from Gnosis…");
  const latestBlock = await client.getBlock();
  const latestBlockNumber = Number(latestBlock.number);
  const latestTimestamp = Number(latestBlock.timestamp);
  console.log(`Latest block: ${latestBlockNumber}, timestamp: ${latestTimestamp}\n`);

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

  console.log(`Year ranges to process: ${yearRanges.map((r) => `${r.year} (blocks ${r.fromBlock}-${r.toBlock})`).join(", ")}\n`);

  const divisor = 10 ** BASE_DECIMALS;
  const byYearLiquidator = {};
  for (const { year } of yearRanges) byYearLiquidator[String(year)] = {};

  const pools = RMM_POOL_ADDRESSES.filter(Boolean);
  if (pools.length === 0) {
    console.log("No RMM pool configured in config.js (RMM_POOL_ADDRESSES).");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(OUTPUT_FILE, JSON.stringify({ realt_liquidators_gnosis: byYearLiquidator }, null, 2), "utf8");
    console.log(`File written (empty): ${OUTPUT_FILE}`);
    return;
  }

  for (const { year, fromBlock, toBlock } of yearRanges) {
    console.log(`\n--- Year ${year} (blocks ${fromBlock}-${toBlock}, ${toBlock - fromBlock + 1} blocks) ---`);
    const logs = await getLogs(pools, liquidationCallEvent, fromBlock, toBlock, `year ${year}`);
    console.log(`Year ${year} done: ${logs.length} LiquidationCall event(s) found.`);

    const amountByLiquidator = {};
    for (const log of logs) {
      const liquidator = log.args?.liquidator;
      const debtAsset = log.args?.debtAsset;
      const debtToCover = log.args?.debtToCover ?? log.args?.[3];
      if (!liquidator || debtToCover == null || debtToCover === 0n) continue;
      const amountBase = debtToBase(debtToCover, debtAsset);
      if (!amountByLiquidator[liquidator]) amountByLiquidator[liquidator] = 0;
      amountByLiquidator[liquidator] += amountBase;
    }

    const entries = Object.entries(amountByLiquidator);
    const total = entries.reduce((acc, [, v]) => acc + v, 0);
    const sorted = entries
      .map(([addr, amount]) => ({
        addr,
        amount: Math.round((amount / divisor) * 100) / 100,
        amount_prorata: total > 0 ? Math.round((amount / total) * 10000) / 10000 : 0,
      }))
      .sort((a, b) => b.amount - a.amount);

    const ranked = {};
    sorted.forEach(({ addr, amount, amount_prorata }, index) => {
      ranked[addr] = { amount, amount_prorata, rank: index + 1 };
    });
    byYearLiquidator[String(year)] = ranked;
  }

  const output = { realt_liquidators_gnosis: byYearLiquidator };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFile written: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
