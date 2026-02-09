# Developers tool

Counts **commits** per year and per member (GitHub author) across **all repositories** of the [RealToken-Community](https://github.com/RealToken-Community) organization. Outputs a JSON in the format of `../data/exemple_data.json`.

## Single command

From `developers`:

```bash
cd developers
npm install
GITHUB_TOKEN=ghp_xxx npm run fetch
```

Output: **`developers/data/realt_community_developers.json`**.

## GitHub token

**GITHUB_TOKEN** is strongly recommended (without a token: 60 requests/hour, the script will fail quickly). Create a [Personal Access Token](https://github.com/settings/tokens) with scope **repo** (read) or at least **public_repo**.

## Environment variables

- **GITHUB_TOKEN**: GitHub access token (recommended).
- **YEARS**: years to process (e.g. `YEARS=2024,2025`) to limit run time.

## Output format

Root key: **RealToken-Community**. For each year, per **GitHub login** (commit author):

- **commits**: number of commits in the org for that year.
- **rank**: ranking (1 = most commits).

Example:

```json
{
  "RealToken-Community": {
    "2023": {
      "byackee": { "commits": 45, "rank": 1 },
      "Sigri44": { "commits": 28, "rank": 2 }
    },
    "2024": { ... }
  }
}
```

Repositories included are those returned by the API `GET /orgs/RealToken-Community/repos` (type `all`).

To retrieve all repositories (public and private), the GitHub token must have access to the private repository. If the token doesn't have access to the private repo, only public repositories will be counted.
