#!/usr/bin/env node

/**
 * Reconstruit un JSON au format realt_liquidators_gnosis.json à partir
 * des seuls CSV dans mock_data (sans appel on-chain).
 * Calcule les totaux v2/v3, les classements par année et globaux.
 *
 * Usage: node build-json-from-mock-data.js
 */

import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_DIR = join(__dirname, "mock_data");
const OUT_DIR = join(__dirname, "..", "data");
const OUT_FILE = join(OUT_DIR, "realt_liquidators_gnosis_from_mock.json");

const WRAPPER = "0x10497611ee6524d75fc45e3739f472f83e282ad5";

function normAddr(addr) {
  return (addr || "").toLowerCase().trim();
}

function parseAmount(str) {
  if (str == null || str === "") return 0;
  const s = String(str).replace(/\s/g, "").replace(/,/g, ".");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function yearFromDate(dateStr) {
  const m = String(dateStr || "").match(/^(\d{4})/);
  return m ? parseInt(m[1], 10) : null;
}

/** Parse "Liquidations RMM - RMM v2.csv" → [{ date, liquidator, amount }] */
function parseRmmV2() {
  const path = join(MOCK_DIR, "Liquidations RMM - RMM v2.csv");
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const liquidatorMatch = line.match(/,(\s*0x[a-fA-F0-9]{40})\s*,/);
    const liquidator = liquidatorMatch ? normAddr(liquidatorMatch[1].trim()) : null;
    if (!liquidator) continue;
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;
    const lastComma = line.lastIndexOf(",");
    const prevComma = line.lastIndexOf(",", lastComma - 1);
    const amountStr = line.slice(prevComma + 1, lastComma).replace(/^"|"$/g, "").replace(/,/g, ".");
    const amount = parseAmount(amountStr);
    rows.push({ date, liquidator, amount });
  }
  return rows;
}

/** Parse "Liquidations RMM - RMM v3.csv" → [{ date, liquidator, amount, isWrapper }] */
function parseRmmV3() {
  const path = join(MOCK_DIR, "Liquidations RMM - RMM v3.csv");
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const liquidatorMatch = line.match(/,(\s*0x[a-fA-F0-9]{40})\s*,/);
    const liquidator = liquidatorMatch ? normAddr(liquidatorMatch[1].trim()) : null;
    if (!liquidator) continue;
    const dateMatch = line.match(/^(\d{4}-\d{2}-\d{2})/);
    const date = dateMatch ? dateMatch[1] : null;
    const lastComma = line.lastIndexOf(",");
    const prevComma = line.lastIndexOf(",", lastComma - 1);
    const amountStr = line.slice(prevComma + 1, lastComma).replace(/^"|"$/g, "").replace(/,/g, ".");
    const amount = parseAmount(amountStr);
    const isWrapper = liquidator === normAddr(WRAPPER);
    rows.push({ date, liquidator, amount, isWrapper });
  }
  return rows;
}

/** Parse "Liquidations RMM - WrapperV3.csv" → [{ date, liquidator }] */
function parseWrapperV3() {
  const path = join(MOCK_DIR, "Liquidations RMM - WrapperV3.csv");
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;
    const date = parts[0].match(/^\d{4}-\d{2}-\d{2}$/) ? parts[0] : null;
    const liquidator = parts[1] && parts[1].startsWith("0x") ? normAddr(parts[1]) : null;
    if (date && liquidator) rows.push({ date, liquidator });
  }
  return rows;
}

/** Assigne le vrai liquidateur aux lignes wrapper V3 : même ordre après tri (date, amount). */
function assignRealLiquidatorToV3Wrapper(v3Rows, wrapperRows) {
  const wrapperOnly = v3Rows.filter((r) => r.isWrapper);
  const nonWrapper = v3Rows.filter((r) => !r.isWrapper);
  if (wrapperOnly.length !== wrapperRows.length) {
    console.warn(`Wrapper count mismatch: v3 wrapper=${wrapperOnly.length}, WrapperV3=${wrapperRows.length}`);
  }
  const byDateAmount = (a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.amount || 0) - (b.amount || 0);
  };
  wrapperOnly.sort(byDateAmount);
  const wrapperSorted = [...wrapperRows].sort((a, b) => a.date.localeCompare(b.date));
  const merged = wrapperOnly.map((r, i) => ({
    date: r.date,
    amount: r.amount,
    liquidator: wrapperSorted[i] ? wrapperSorted[i].liquidator : r.liquidator,
  }));
  return [...merged, ...nonWrapper.map((r) => ({ date: r.date, amount: r.amount, liquidator: r.liquidator }))];
}

function aggregateByYearAndLiquidator(rows) {
  const byYear = {};
  for (const { date, liquidator, amount } of rows) {
    const year = yearFromDate(date);
    if (!year) continue;
    if (!byYear[year]) byYear[year] = {};
    const addr = normAddr(liquidator);
    if (!byYear[year][addr]) byYear[year][addr] = { amount: 0, count: 0 };
    byYear[year][addr].amount += amount;
    byYear[year][addr].count += 1;
  }
  return byYear;
}

function buildRankedByYear(byYearRaw) {
  const byYear = {};
  for (const [year, addrs] of Object.entries(byYearRaw)) {
    const entries = Object.entries(addrs)
      .map(([addr, o]) => ({ addr, amount: Math.round(o.amount * 100) / 100, count: o.count }))
      .filter((x) => x.amount > 0 || x.count > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((s, x) => s + x.amount, 0);
    const ranked = {};
    entries.forEach(({ addr, amount, count }, i) => {
      ranked[addr] = {
        amount,
        amount_prorata: total > 0 ? Math.round((amount / total) * 10000) / 10000 : 0,
        rank: i + 1,
      };
    });
    byYear[year] = ranked;
  }
  return byYear;
}

function buildTotalsWithCount(byYearRaw) {
  const totals = {};
  for (const addrs of Object.values(byYearRaw)) {
    for (const [addr, o] of Object.entries(addrs)) {
      const a = normAddr(addr);
      if (!totals[a]) totals[a] = { amountBase: 0, count: 0 };
      totals[a].amountBase += o.amount;
      totals[a].count += o.count;
    }
  }
  const entries = Object.entries(totals)
    .map(([addr, o]) => ({
      addr,
      amount: Math.round(o.amountBase * 100) / 100,
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

function main() {
  console.log("Construction du JSON à partir des CSV mock_data…\n");

  const v2Rows = parseRmmV2();
  const v3RowsRaw = parseRmmV3();
  const wrapperRows = parseWrapperV3();

  const v3Rows = assignRealLiquidatorToV3Wrapper(v3RowsRaw, wrapperRows);

  console.log("V2:", v2Rows.length, "lignes");
  console.log("V3:", v3Rows.length, "lignes (dont wrapper → vrai liquidateur)");

  const v2ByYearRaw = aggregateByYearAndLiquidator(v2Rows);
  const v3ByYearRaw = aggregateByYearAndLiquidator(v3Rows);

  const v2ByYear = buildRankedByYear(v2ByYearRaw);
  const v3ByYear = buildRankedByYear(v3ByYearRaw);

  const years = [...new Set([...Object.keys(v2ByYear), ...Object.keys(v3ByYear)])].map(Number).sort((a, b) => a - b);

  const realt_liquidators_gnosis = {};
  for (const year of years) {
    const v2 = v2ByYear[String(year)] || {};
    const v3 = v3ByYear[String(year)] || {};
    const combined = {};
    for (const [addr, o] of Object.entries(v2)) {
      combined[addr] = { amount: o.amount, amount_prorata: o.amount_prorata, rank: 0 };
    }
    for (const [addr, o] of Object.entries(v3)) {
      if (!combined[addr]) combined[addr] = { amount: 0, amount_prorata: 0, rank: 0 };
      combined[addr].amount += o.amount;
      combined[addr].amount_prorata += o.amount_prorata;
    }
    const entries = Object.entries(combined)
      .map(([addr, o]) => ({ addr, amount: Math.round(o.amount * 100) / 100 }))
      .filter((x) => x.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    const total = entries.reduce((s, x) => s + x.amount, 0);
    const ranked = {};
    entries.forEach(({ addr, amount }, i) => {
      ranked[addr] = {
        amount,
        amount_prorata: total > 0 ? Math.round((amount / total) * 10000) / 10000 : 0,
        rank: i + 1,
      };
    });
    realt_liquidators_gnosis[String(year)] = ranked;
  }

  const liquidators_v2_total = buildTotalsWithCount(v2ByYearRaw);
  const liquidators_v3_total = buildTotalsWithCount(v3ByYearRaw);
  const v2_total_events = v2Rows.length;
  const v3_total_events = v3Rows.length;

  const output = {
    execution_script: new Date().toISOString(),
    source: "mock_data_csv",
    v2_total_events,
    v3_total_events,
    liquidators_v2_total,
    liquidators_v3_total,
    realt_liquidators_gnosis,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log("\nFichier écrit:", OUT_FILE);
  console.log("  v2:", v2_total_events, "| v3:", v3_total_events);
  console.log("  années:", years.join(", "));
}

main();
