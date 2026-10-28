# Triage

**Finds duplicate GitHub issues by meaning, the moment they're opened.**

Large open-source repositories get the same bug reported again and again, each time in different words. Maintainers lose hours finding the earlier report, the discussion, or the pull request that already fixed it.

Triage watches a repository. When a new issue is opened, it compares the issue's *meaning*, not its keywords, against every earlier issue, and puts likely duplicates on a live dashboard for a maintainer to confirm or dismiss. It never closes anything on its own.

Demoed on [`appwrite/appwrite`](https://github.com/appwrite/appwrite): 600 real issues indexed, including real duplicates such as

- #10944 *Traefik 2.11 is incompatible with latest docker ce* ↔ #10801 *Traefik stops working with docker v29* (91% similar)
- #13016 *openruntimes-executor crash loop after upgrading Appwrite* ↔ #12796 *openruntimes-executor crashes at boot* (91% similar)

## How it works

```
GitHub issue opened ──webhook──▶ Appwrite Function "triage"
                                   1. Appwrite Embeddings: issue text → 768-number vector
                                   2. VectorsDB: closest earlier issues by cosine similarity
                                   3. TablesDB: store the issue and its likely duplicates
                                                │
                     React dashboard ◀── Realtime: new issues and duplicates appear live
                     (Appwrite Sites)
```

| Appwrite product | Role |
|---|---|
| **VectorsDB** | Stores one vector per issue and finds the nearest ones with `Query.vectorCosine` |
| **Embeddings** | Turns issue text into vectors with `nomic-embed-text`, inside Appwrite, with no outside AI service |
| **TablesDB** | Issues (with the pull request that fixed them) and suggested duplicates with their review status |
| **Realtime** | The dashboard updates the moment a new issue or duplicate is stored |
| **Functions** | Receives the GitHub webhook (signature verified), checks pasted issues, and records reviews |
| **Sites** | Hosts the dashboard |

### Choosing what counts as a duplicate

The threshold comes from reading real pairs from `appwrite/appwrite`, not from a guess:

| Similarity | What the pairs were |
|---|---|
| 90% and above | The same report filed twice |
| 85–90% | Usually the same area, but different bugs |
| below 85% | Related topics only |

So Triage suggests a duplicate from **88%**, and marks it *very likely* from **92%**.

## Features

- **Live duplicate feed:** each new report next to the issue it most likely repeats, with its similarity, state, and the pull request that fixed it.
- **Review:** *Duplicate* or *Not related*, with undo. Decisions are kept when issues are re-analyzed.
- **Check before filing:** paste a bug report to see whether it was already reported, and whether it was fixed.
- **Activity line:** every checked issue shows up, including the ones without duplicates.

## Project layout

```
functions/triage/   Appwrite Function: webhook, /check and /review; shared triage logic in src/triage.js
scripts/            setup, import, analyze, search, deploy and cleanup scripts
web/                React + Vite dashboard
```

## Running it

You need Node.js 22, an Appwrite project (Appwrite Cloud, or self-hosted with VectorsDB and Embeddings enabled), and a GitHub token.

1. **API key:** in the Appwrite Console, create an API key with these scopes: `databases.*`, `tables.*`, `columns.*`, `indexes.*`, `rows.*`, `embeddings.write`, `vectorsdb.*`, `functions.*`, `execution.*`, `sites.*`.
2. **Configure:** copy `.env.example` to `.env` and fill it in. `GITHUB_WEBHOOK_SECRET` is any long random string.
3. **Install and set up:**
   ```bash
   cd scripts && npm install
   cd ../functions/triage && npm install
   cd ../../scripts
   node setup.mjs             # databases, tables, indexes and the vector collection
   node import.mjs 600        # recent issues of GITHUB_REPO, with embeddings
   node analyze.mjs           # suggest duplicates among them
   node search.mjs "uploads fail for big files"   # try a search
   ```
4. **Deploy:**
   ```bash
   node deploy-function.mjs
   node deploy-site.mjs
   ```
   In the Appwrite Console, add a **Web platform** for the site's domain, so the dashboard may call the API.
5. **Connect GitHub:** in the repository's *Settings → Webhooks*, add a webhook:
   - Payload URL: the triage function's domain (Console → Functions → triage → Domains)
   - Content type: `application/json`
   - Secret: the same `GITHUB_WEBHOOK_SECRET`
   - Events: *Issues* only

To run the dashboard locally: `cd web && npm install && npm run dev`, with `web/.env` filled from `web/.env.example`.

## Security

- GitHub webhooks are accepted only with a valid `X-Hub-Signature-256` signature (HMAC-SHA256, compared in constant time).
- The dashboard can read issues and suggestions, but writes go only through the function, which validates its input.
- The function uses Appwrite's per-execution API key, limited to the scopes it needs.

Built for the Appwrite Databases Hackathon, October 2026.
