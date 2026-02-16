#!/usr/bin/env node

/**
 * RMM borrowers on Gnosis: per user per year we output interest, interest_prorata, and rank only.
 *
 * Important: le Pool/LendingPool n’émet PAS Mint/Burn. Ces événements sont émis par les contrats
 * VariableDebtToken (un par réserve). On fait donc :
 *   1. Sur le pool (LendingPool v2 ou Pool v3) : getReservesList() + getReserveData(asset) pour
 *      récupérer les adresses des VariableDebtToken.
 *   2. On indexe Mint et Burn sur ces contrats VariableDebtToken ; interest = sum de balanceIncrease.
 * En v2 les events n’ont pas balanceIncrease ; on utilise le champ amount (dette mint/burn) comme proxy
 * pour indexer les users et remplir 2022/2023 (intérêt approximatif).
 *
 * Pas de snapshots pool (getUserAccountData) ni formule résiduelle.
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
  POOL_DEPLOYMENT_BLOCKS,
} from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "realt_borrowers_gnosis.json");
const BASE_DECIMALS = DEBT_BASE_DECIMALS;

const poolReserveAbiV3 = JSON.parse(
  readFileSync(join(__dirname, "pool-reserve-abi.json"), "utf8")
);
const poolReserveAbiV2 = JSON.parse(
  readFileSync(join(__dirname, "pool-reserve-abi-v2.json"), "utf8")
);

// v3 : Mint/Burn avec balanceIncrease (intérêt accru)
const debtTokenMintEventV3 = parseAbiItem(
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 amountToMint, uint256 balanceIncrease, uint256 index)"
);
const debtTokenBurnEventV3 = parseAbiItem(
  "event Burn(address indexed from, address indexed target, uint256 amountToBurn, uint256 balanceIncrease, uint256 index)"
);
// v2 : signatures différentes (pas de balanceIncrease dans l’event)
const debtTokenMintEventV2 = parseAbiItem(
  "event Mint(address indexed caller, address indexed onBehalfOf, uint256 amount, uint256 index)"
);
const debtTokenBurnEventV2 = parseAbiItem(
  "event Burn(address indexed from, uint256 amount, uint256 index)"
);

const client = createPublicClient({
  chain: gnosis,
  transport: http(GNOSIS_RPC, { timeout: 120_000 }),
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
  // RPC par défaut (rpc.gnosis.gateway.fm) accepte de plus grandes plages ; réduire si "exceed maximum block range"
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

/**
 * Détecte l’interface d’un pool (v2 ou v3) en testant getReserveData sur la première réserve.
 * - v3 : struct avec configuration, variableBorrowIndex, variableDebtTokenAddress, etc.
 * - v2 : struct avec liquidityIndex, variableBorrowIndex, variableDebtTokenAddress (index 9).
 * Retourne { abi, variableDebtKey } où variableDebtKey est le chemin pour extraire l’adresse (v3: .variableDebtTokenAddress, v2: [9]).
 */
async function detectPoolInterface(pool, reservesList, blockNumber) {
  if (!reservesList?.length) return null;
  const opts = { address: pool, args: [reservesList[0]] };
  try {
    await client.readContract({
      ...opts,
      abi: poolReserveAbiV3,
      functionName: "getReserveData",
      blockNumber: BigInt(blockNumber),
    });
    return { abi: poolReserveAbiV3, version: "v3" };
  } catch (_) {
    try {
      await client.readContract({
        ...opts,
        abi: poolReserveAbiV2,
        functionName: "getReserveData",
        blockNumber: BigInt(blockNumber),
      });
      return { abi: poolReserveAbiV2, version: "v2" };
    } catch (_) {
      try {
        await client.readContract({
          ...opts,
          abi: poolReserveAbiV2,
          functionName: "getReserveData",
        });
        return { abi: poolReserveAbiV2, version: "v2" };
      } catch (_) {
        return null;
      }
    }
  }
}

/** Extrait variableDebtTokenAddress depuis la réponse getReserveData (v2 ou v3). */
function getVariableDebtTokenAddress(data, version) {
  if (!data) return null;
  const addr = data.variableDebtTokenAddress ?? data[10] ?? data[9];
  if (!addr || addr === "0x0000000000000000000000000000000000000000") return null;
  return addr;
}

/**
 * Même logique pour RMM v2 et v3 : getReservesList puis getReserveData par réserve.
 * Mint/Burn sont comptabilisés sur les VariableDebtToken de chaque réserve (crypto) exactement
 * comme pour la v3 : une seule boucle, mêmes événements, même agrégation par user.
 * - On ne garde que les réserves listées dans RESERVE_DECIMALS (crypto/stablecoins, pas RealTokens).
 * @param blockNumber - block auquel lire l’état (si le RPC ne supporte pas l’historique, fallback sans blockNumber).
 * @param options.silent - si true, pas de log (utilisé pour la découverte par année).
 */
async function getReservesAndDebtTokens(blockNumber, options = {}) {
  const { silent = false } = options;
  const out = [];
  for (const pool of RMM_POOL_ADDRESSES) {
    const deploymentBlock = POOL_DEPLOYMENT_BLOCKS?.[pool.toLowerCase()];
    if (deploymentBlock != null && blockNumber < deploymentBlock) continue;

    let reservesList = [];
    for (const abi of [poolReserveAbiV3, poolReserveAbiV2]) {
      try {
        reservesList = await client.readContract({
          address: pool,
          abi,
          functionName: "getReservesList",
          blockNumber: BigInt(blockNumber),
        });
        if (reservesList?.length) break;
      } catch (_) {
        try {
          reservesList = await client.readContract({
            address: pool,
            abi,
            functionName: "getReservesList",
          });
          if (reservesList?.length) break;
        } catch (_) {}
      }
    }
    if (!reservesList?.length) continue;

    const iface = await detectPoolInterface(pool, reservesList, blockNumber);
    if (!iface) continue;

    let count = 0;
    for (const reserve of reservesList) {
      if (RESERVE_DECIMALS[reserve.toLowerCase()] == null) continue;
      let data;
      try {
        data = await client.readContract({
          address: pool,
          abi: iface.abi,
          functionName: "getReserveData",
          args: [reserve],
          blockNumber: BigInt(blockNumber),
        });
      } catch (_) {
        try {
          data = await client.readContract({
            address: pool,
            abi: iface.abi,
            functionName: "getReserveData",
            args: [reserve],
          });
        } catch (_) {
          data = null;
        }
      }
      const variableDebtTokenAddress = getVariableDebtTokenAddress(data, iface.version);
      if (variableDebtTokenAddress) {
        out.push({ pool, reserve, variableDebtTokenAddress });
        count++;
      }
    }
    if (count > 0 && !silent) {
      console.log(`Pool ${pool.slice(0, 10)}… (RMM ${iface.version}): ${count} debt token(s) from ${reservesList.length} reserve(s)`);
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

  // Découverte des debt tokens au block actuel (évite les échecs RPC sur état historique)
  const reserveDebtTokens = await getReservesAndDebtTokens(latestBlockNumber);
  if (reserveDebtTokens.length === 0) {
    console.log("No variable debt tokens found for any pool; nothing to fetch.");
    const output = { realt_borrowers_gnosis: byYearUser };
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
    console.log(`File written: ${OUTPUT_FILE}`);
    return;
  }

  for (const { year, fromBlock, toBlock } of yearRanges) {
    // Essayer d’abord les debt tokens à la fin de l’année (adresses historiques) ; sinon garder la liste actuelle
    let activeDebtTokens;
    try {
      const yearTokens = await getReservesAndDebtTokens(toBlock, { silent: true });
      if (yearTokens.length > 0) {
        activeDebtTokens = yearTokens.filter(({ pool }) => {
          const deploymentBlock = POOL_DEPLOYMENT_BLOCKS?.[pool.toLowerCase()];
          return deploymentBlock == null || deploymentBlock <= toBlock;
        });
        if (activeDebtTokens.length > 0) {
          console.log(`Year ${year}: using debt tokens at block ${toBlock} (historical).`);
        }
      }
    } catch (_) {}
    if (!activeDebtTokens || activeDebtTokens.length === 0) {
      activeDebtTokens = reserveDebtTokens.filter(({ pool }) => {
        const deploymentBlock = POOL_DEPLOYMENT_BLOCKS?.[pool.toLowerCase()];
        return deploymentBlock == null || deploymentBlock <= toBlock;
      });
      if (activeDebtTokens.length === 0) {
        console.log(`Year ${year}: no pool deployed yet; skipping.`);
        continue;
      }
    }

    const debtTokenToReserve = {};
    const debtTokensByPool = {};
    for (const { pool, reserve, variableDebtTokenAddress } of activeDebtTokens) {
      debtTokenToReserve[variableDebtTokenAddress.toLowerCase()] = reserve;
      if (!debtTokensByPool[pool]) debtTokensByPool[pool] = [];
      debtTokensByPool[pool].push(variableDebtTokenAddress);
    }

    const allMintLogs = [];
    const allBurnLogs = [];
    const V3_POOL = "0xfb9b496519fca8473fba1af0850b6b8f476bfdb3";
    for (const [pool, debtTokenAddresses] of Object.entries(debtTokensByPool)) {
      const deploymentBlock = POOL_DEPLOYMENT_BLOCKS?.[pool.toLowerCase()];
      const adjustedFromBlock = deploymentBlock != null ? Math.max(fromBlock, deploymentBlock) : fromBlock;
      const isV3 = pool.toLowerCase() === V3_POOL;
      const mintEvent = isV3 ? debtTokenMintEventV3 : debtTokenMintEventV2;
      const burnEvent = isV3 ? debtTokenBurnEventV3 : debtTokenBurnEventV2;
      const version = isV3 ? "v3" : "v2";
      const [mintLogs, burnLogs] = await Promise.all([
        getLogs(debtTokenAddresses, mintEvent, adjustedFromBlock, toBlock),
        getLogs(debtTokenAddresses, burnEvent, adjustedFromBlock, toBlock),
      ]);
      mintLogs.forEach((l) => { l._version = version; });
      burnLogs.forEach((l) => { l._version = version; });
      allMintLogs.push(...mintLogs);
      allBurnLogs.push(...burnLogs);
      console.log(`Year ${year} RMM ${version}: ${debtTokenAddresses.length} reserve(s), Mint ${mintLogs.length}, Burn ${burnLogs.length}`);
    }
    const mintLogs = allMintLogs;
    const burnLogs = allBurnLogs;

    const users = new Set();
    const interestFromDebtTokenByUser = {};
    for (const log of mintLogs) {
      const user = log.args?.onBehalfOf;
      if (!user) continue;
      const reserve = debtTokenToReserve[log.address?.toLowerCase()];
      if (reserve == null) continue;
      // v3 : balanceIncrease = intérêt accru. v2 : pas de balanceIncrease, on utilise amount comme proxy pour indexer les users
      const value = log._version === "v3"
        ? (log.args?.balanceIncrease ?? log.args?.[3])
        : (log.args?.amount ?? log.args?.[2]);
      if (value != null && value > 0n) {
        users.add(user);
        if (!interestFromDebtTokenByUser[user]) interestFromDebtTokenByUser[user] = 0;
        interestFromDebtTokenByUser[user] += reserveAmountToBase(value, reserve);
      }
    }
    for (const log of burnLogs) {
      const user = log.args?.from;
      if (!user) continue;
      const reserve = debtTokenToReserve[log.address?.toLowerCase()];
      if (reserve == null) continue;
      const value = log._version === "v3"
        ? (log.args?.balanceIncrease ?? log.args?.[3])
        : (log.args?.amount ?? log.args?.[1]);
      if (value != null && value > 0n) {
        users.add(user);
        if (!interestFromDebtTokenByUser[user]) interestFromDebtTokenByUser[user] = 0;
        interestFromDebtTokenByUser[user] += reserveAmountToBase(value, reserve);
      }
    }

    console.log(`Year ${year}, debt tokens: ${activeDebtTokens.length}, Mint ${mintLogs.length}, Burn ${burnLogs.length}`);

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
