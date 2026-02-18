#!/usr/bin/env node

import "dotenv/config";

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
  RMM_V2_POOL,
  RMM_V3_POOL,
  RMM_V3_WRAPPER,
  YEAR_STARTS,
  GNOSIS_BLOCK_TIME,
} from "./config.js";

/** Décimales par token de dette (debtAsset). Autres tokens → défaut 18. Pas de conversion USD : on somme les montants nominaux normalisés en 8 décimales. */
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

/** Déduit l'année à partir d'un timestamp Unix (cohérent avec YEAR_STARTS). */
function yearFromTimestamp(ts) {
  const years = Object.keys(YEAR_STARTS).map(Number).sort((a, b) => a - b);
  for (let i = years.length - 1; i >= 0; i--) {
    if (ts >= YEAR_STARTS[years[i]]) return years[i];
  }
  return years[0];
}

function normAddr(addr) {
  return (addr || "").toLowerCase();
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
  const chunk = 500_000;
  const logs = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + chunk - 1, toBlock);
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

  const v2Pool = RMM_V2_POOL.toLowerCase();
  const v3Pool = RMM_V3_POOL.toLowerCase();
  const wrapperAddr = RMM_V3_WRAPPER.toLowerCase();
  const v2Totals = {}; // addr -> { amountBase, count }
  const v3Totals = {};

  const pools = RMM_POOL_ADDRESSES.filter(Boolean);
  if (pools.length === 0) {
    console.log("No RMM pool configured in config.js (RMM_POOL_ADDRESSES).");
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(OUTPUT_FILE, JSON.stringify({ execution_script: new Date().toISOString(), realt_liquidators_gnosis: byYearLiquidator }, null, 2), "utf8");
    console.log(`File written (empty): ${OUTPUT_FILE}`);
    return;
  }

  /** Récupère le timestamp de chaque bloc (par batch) et retourne blockNumber → année. Si getBlock échoue, estimation par bloc. */
  async function getBlockToYearMap(blockNumbers, refBlock, refTs) {
    const unique = [...new Set(blockNumbers)].filter((b) => b != null);
    const map = {};
    const chunk = 80;
    for (let i = 0; i < unique.length; i += chunk) {
      const batch = unique.slice(i, i + chunk);
      const blocks = await Promise.all(
        batch.map((bn) => client.getBlock({ blockNumber: BigInt(bn) }).catch(() => null))
      );
      batch.forEach((bn, j) => {
        const ts = blocks[j]?.timestamp;
        if (ts != null) {
          map[bn] = yearFromTimestamp(Number(ts));
        } else {
          const estimatedTs = refTs + (bn - refBlock) * GNOSIS_BLOCK_TIME;
          map[bn] = yearFromTimestamp(estimatedTs);
        }
      });
      await sleep(150);
    }
    return map;
  }

  async function getTxFromMap(logs) {
    const wrapperEntries = [];
    for (const log of logs) {
      const isV3 = (log.address || "").toLowerCase() === v3Pool;
      const liquidator = (log.args?.liquidator || "").toLowerCase();
      if (isV3 && liquidator === wrapperAddr)
        wrapperEntries.push({
          txHash: log.transactionHash,
          blockNumber: Number(log.blockNumber),
          transactionIndex: log.transactionIndex,
        });
    }
    const byHash = new Map();
    for (const e of wrapperEntries) byHash.set(e.txHash, e);
    const unique = [...byHash.entries()];
    const map = {};
    const chunk = 50;
    for (let i = 0; i < unique.length; i += chunk) {
      const batch = unique.slice(i, i + chunk);
      const txs = await Promise.all(
        batch.map(([, e]) => client.getTransaction({ hash: e.txHash }).catch(() => null))
      );
      const missing = [];
      batch.forEach(([h, e], j) => {
        const from = txs[j]?.from;
        if (from) map[h] = from;
        else missing.push(e);
      });
      for (const e of missing) {
        try {
          const block = await client.getBlock({
            blockNumber: BigInt(e.blockNumber),
            includeTransactions: true,
          });
          const tx = block.transactions?.[e.transactionIndex];
          if (tx && typeof tx === "object" && tx.from) map[e.txHash] = tx.from;
        } catch (_) {}
        await sleep(100);
      }
      await sleep(200);
    }
    return map;
  }

  const allLogs = [];
  for (const { year, fromBlock, toBlock } of yearRanges) {
    console.log(`\n--- Year ${year} (blocks ${fromBlock}-${toBlock}, ${toBlock - fromBlock + 1} blocks) ---`);
    const logs = await getLogs(pools, liquidationCallEvent, fromBlock, toBlock, `year ${year}`);
    console.log(`Year ${year} done: ${logs.length} LiquidationCall event(s) found.`);
    allLogs.push(...logs);
  }

  console.log(`\nAttribution des années d'après le timestamp réel de chaque bloc…`);
  const blockNumbers = allLogs.map((l) => Number(l.blockNumber));
  const blockToYear = await getBlockToYearMap(blockNumbers, latestBlockNumber, latestTimestamp);
  const txFromMap = await getTxFromMap(allLogs);
  const wrapperTxCount = Object.keys(txFromMap).length;
  if (wrapperTxCount > 0) console.log(`  V3 wrapper: ${wrapperTxCount} tx(s) → vrai liquidateur (tx.from)`);

  const byYearAmount = {};
  for (const log of allLogs) {
    const blockNum = Number(log.blockNumber);
    const year = blockToYear[blockNum];
    if (year == null) continue;
    let liquidator = log.args?.liquidator;
    const debtAsset = log.args?.debtAsset;
    const debtToCover = log.args?.debtToCover ?? log.args?.[3];
    if (!liquidator || debtToCover == null || debtToCover === 0n) continue;
    const isV2 = (log.address || "").toLowerCase() === v2Pool;
    if (!isV2 && (liquidator || "").toLowerCase() === wrapperAddr) {
      const real = txFromMap[log.transactionHash];
      if (real) liquidator = real;
    }
    const addr = normAddr(liquidator);
    const amountBase = debtToBase(debtToCover, debtAsset);
    if (isV2) {
      if (!v2Totals[addr]) v2Totals[addr] = { amountBase: 0, count: 0 };
      v2Totals[addr].amountBase += amountBase;
      v2Totals[addr].count += 1;
    } else {
      if (!v3Totals[addr]) v3Totals[addr] = { amountBase: 0, count: 0 };
      v3Totals[addr].amountBase += amountBase;
      v3Totals[addr].count += 1;
    }
    if (!byYearAmount[year]) byYearAmount[year] = {};
    if (!byYearAmount[year][addr]) byYearAmount[year][addr] = 0;
    byYearAmount[year][addr] += amountBase;
  }

  for (const year of Object.keys(byYearLiquidator)) {
    const amountByLiquidator = byYearAmount[year] || {};
    const entries = Object.entries(amountByLiquidator)
      .map(([addr, amount]) => ({ addr, amount }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((acc, x) => acc + x.amount, 0);
    const ranked = {};
    entries.forEach(({ addr, amount }, index) => {
      ranked[addr] = {
        amount: Math.round((amount / divisor) * 100) / 100,
        amount_prorata: total > 0 ? Math.round((amount / total) * 10000) / 10000 : 0,
        rank: index + 1,
      };
    });
    byYearLiquidator[year] = ranked;
  }

  function buildRankedWithCount(totals) {
    const entries = Object.entries(totals)
      .map(([addr, o]) => ({
        addr,
        amount: Math.round((o.amountBase / divisor) * 100) / 100,
        count: o.count ?? 0,
      }))
      .filter((x) => x.count > 0 || x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const out = {};
    entries.forEach(({ addr, amount, count }, i) => {
      out[addr] = { amount, count, rank: i + 1 };
    });
    return out;
  }

  const v2TotalEvents = Object.values(v2Totals).reduce((s, o) => s + (o.count ?? 0), 0);
  const v3TotalEvents = Object.values(v3Totals).reduce((s, o) => s + (o.count ?? 0), 0);
  const liquidators_v2_total = buildRankedWithCount(v2Totals);
  const liquidators_v3_total = buildRankedWithCount(v3Totals);

  const output = {
    execution_script: new Date().toISOString(),
    v2_total_events: v2TotalEvents,
    v3_total_events: v3TotalEvents,
    liquidators_v2_total,
    liquidators_v3_total,
    realt_liquidators_gnosis: byYearLiquidator,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFile written: ${OUTPUT_FILE} (v2: ${v2TotalEvents}, v3: ${v3TotalEvents})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
