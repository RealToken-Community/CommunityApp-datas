/**
 * Configuration for counting GitHub commits (RealToken-Community organization).
 */

export const GITHUB_ORG = "RealToken-Community";
export const GITHUB_API_BASE = "https://api.github.com";

/** Token GitHub (required to avoid the 60 req/h limit). Create a PAT with scope repo (read). */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

/** Years to include. */
export const YEARS_CONFIG = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
