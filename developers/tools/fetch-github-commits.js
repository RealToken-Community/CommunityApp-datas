#!/usr/bin/env node

/**
 * Counts commits by year and member (GitHub author) on all repositories
 * of the RealToken-Community organization. Produces a JSON file in the format exemple_data.json.
 *
 * Output: ../data/realt_community_developers.json
 * Requires GITHUB_TOKEN (environment variable) for correct usage (rate limit).
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { GITHUB_ORG, GITHUB_API_BASE, GITHUB_TOKEN, YEARS_CONFIG } from "./config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "realt_community_developers.json");

const headers = {
  Accept: "application/vnd.github.v3+json",
  ...(GITHUB_TOKEN && { Authorization: `Bearer ${GITHUB_TOKEN}` }),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { ...headers, ...options.headers } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url} ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchPaginated(urlTemplate, perPage = 100) {
  const out = [];
  let page = 1;
  for (;;) {
    const url = urlTemplate.includes("?") ? `${urlTemplate}&page=${page}&per_page=${perPage}` : `${urlTemplate}?page=${page}&per_page=${perPage}`;
    const data = await fetchJson(url);
    await sleep(400);
    if (data == null) break;
    if (Array.isArray(data)) {
      if (data.length === 0) break;
      out.push(...data);
      if (data.length < perPage) break;
    } else {
      break;
    }
    page++;
  }
  return out;
}

/** List all repositories of the org (only name). */
async function listOrgRepos() {
  const url = `${GITHUB_API_BASE}/orgs/${GITHUB_ORG}/repos?type=all`;
  const repos = await fetchPaginated(url);
  return repos.map((r) => r.name);
}

/** Retrieve all commits of a repo for a year (by pagination). */
async function listCommitsForYear(repo, year) {
  const since = `${year}-01-01T00:00:00Z`;
  const until = `${year}-12-31T23:59:59Z`;
  const url = `${GITHUB_API_BASE}/repos/${GITHUB_ORG}/${repo}/commits?since=${since}&until=${until}`;
  const commits = await fetchPaginated(url);
  return commits;
}

/** Extract the author login of a commit (or fallback email/name). */
function authorKey(commit) {
  if (commit.author && commit.author.login) return commit.author.login;
  const c = commit.commit && commit.commit.author;
  if (c && c.email) return c.email;
  if (c && c.name) return c.name;
  return "unknown";
}

async function main() {
  console.log("Developers – counting GitHub commits RealToken-Community by year…\n");
  if (!GITHUB_TOKEN) {
    console.warn("⚠ GITHUB_TOKEN not defined: 60 req/h limit, risk of failure.");
  }

  const repos = await listOrgRepos();
  console.log(`Repositories found: ${repos.length}`);

  const years = process.env.YEARS ? process.env.YEARS.split(",").map((y) => parseInt(y.trim(), 10)) : YEARS_CONFIG;
  const commitsByYear = {};
  for (const y of years) commitsByYear[String(y)] = {};

  for (const year of years) {
    console.log(`\nYear ${year}…`);
    for (const repo of repos) {
      try {
        const commits = await listCommitsForYear(repo, year);
        for (const c of commits) {
          const author = authorKey(c);
          if (!commitsByYear[String(year)][author]) commitsByYear[String(year)][author] = 0;
          commitsByYear[String(year)][author]++;
        }
        if (commits.length > 0) console.log(`  ${repo}: ${commits.length} commits`);
      } catch (e) {
        console.warn(`  ${repo}: ${e.message}`);
      }
    }
  }

  // Convert to { commits, rank } format and sort by rank
  const outputByYear = {};
  for (const year of Object.keys(commitsByYear)) {
    const entries = Object.entries(commitsByYear[year])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1]);
    const ranked = {};
    entries.forEach(([login], i) => {
      ranked[login] = { commits: commitsByYear[year][login], rank: i + 1 };
    });
    outputByYear[year] = ranked;
  }

  const output = { [GITHUB_ORG]: outputByYear };
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFile written: ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
