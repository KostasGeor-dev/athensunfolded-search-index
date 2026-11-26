# athensunfolded-search-index

Public, machine-readable full-text search index for the [Athens Unfolded](https://www.athensunfolded.com) blog.
It is built **only from public pages** of the website and contains **words, not article text**: no HTML, images, navigation, consent banner, scripts, drafts, checkout or funnel pages, and no personal data or credentials.

## What is published
`docs/` is served by GitHub Pages:

| File | Purpose |
|---|---|
| `manifest.json` | small pointer: index file name, SHA-256, article count, `generation` (when the content last changed) and `verifiedAt` (last successful check against the live site) |
| `search-index.<hash>.json` | the index (content-hashed name, so a changed index always has a new URL) |
| `search-index.json` | same content under a stable name |
| `changes.json` | what the last content change added / updated / removed |
| `index.html`, `.nojekyll` | placeholder page (`noindex`) and Pages setting |

## How it is refreshed
`.github/workflows/update-search-index.yml` runs every six hours (minute 37 of 01, 07, 13, 19 UTC) and on demand (*Actions → Update search index → Run workflow*).
Scheduled runs are **best effort**: GitHub may delay or skip them. Steps: self-tests on synthetic data → polite crawl (1.5 s between requests) → completeness check (published articles = indexed articles) → commit. If any step fails nothing is committed, so the **last good index stays published**; GitHub emails the repository owner about the failed run.

Safety gates in `builder/build_index.js`: every published article must be readable; inventory must equal index; a sudden drop of more than max(2, 20 %) of the articles is rejected; size limit 8 MB; every article must be findable by its own title. Exit codes: 0 ok/unchanged, 2 rejected, 3 blocked or unreachable.

## Local use
Node 18+, no dependencies.
```
npm test        # synthetic self-tests (no network)
npm run build   # crawl the live site politely and write docs/
npm run check   # published articles vs docs/
```
Rollback: revert the commit that introduced a bad index (`git revert <sha>`); Pages republishes the previous one.

## Scope
Not part of this repository: the website itself, Homepage code, tracking, consent, checkout, e-mail automation, affiliate configuration. Nothing here is a secret. The workflow uses only the job's own short-lived `GITHUB_TOKEN`.
