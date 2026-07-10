# mayfly-demo

A public, live showcase for [Mayfly](https://github.com/mikeng-io/mayfly) — ephemeral GitHub Actions
runners on AWS Lambda MicroVMs. Click a button, watch a **fresh single-use MicroVM** boot in CI, run one
job, print its own kernel fingerprint, and get **destroyed**.

## What it shows

Each trigger dispatches a GitHub Actions workflow that runs on a Mayfly self-hosted runner. The job
fingerprints the MicroVM it's running in (arch `aarch64`, kernel, fresh `/tmp`) and posts a **receipt**
to the demo API. The static site renders the receipts as a live feed — proof that every job got its own
isolated, disposable VM.

```
click Trigger → API workflow_dispatch → GitHub queues job → Mayfly provisions a MicroVM
   → runner fingerprints the VM → POST /receipt → VM terminated → site shows the receipt
```

## Parts

| Path | What |
|---|---|
| `web/index.html` | the static site — self-contained, **works in mock mode with no backend** (great for the article) |
| `.github/workflows/showcase.yml` | the job that runs on `[self-hosted, mayfly]` and posts its VM fingerprint |
| `api/src/handler.ts` | Lambda (Function URL): `POST /trigger` (rate-limited), `GET /runs`, `POST /receipt` |
| `api/infra/` | CDK: DynamoDB (receipts + cooldown) + the API Lambda |

## Run the site locally (mock mode — no AWS)

Open `web/index.html` in a browser. With no `?api=` it runs in **mock mode**: the lifecycle and receipts
are simulated, so the page is fully demoable before the control plane exists. Point it at a real backend
with `web/index.html?api=https://<demo-api-url>`.

## Go live (needs Mayfly deployed)

1. Deploy Mayfly (see the mayfly repo's Phase 6 runbook) and install its GitHub App on **this** repo.
2. `cd api && npm ci && cd infra && npm ci && npm run deploy` → note the `ApiUrl` output.
3. Set the two SSM params out-of-band: `/mayfly-demo/ghToken` (fine-grained PAT, `actions:write` on this
   repo) and `/mayfly-demo/receiptToken` (any shared secret).
4. Repo config: variable `MAYFLY_DEMO_API` = the `ApiUrl`; secret `MAYFLY_RECEIPT_TOKEN` = the receipt token.
5. Host `web/index.html` (S3+CloudFront / GitHub Pages) and load it with `?api=<ApiUrl>` (or set
   `window.MAYFLY_API`).

## Hosting: GitHub Pages + PR previews

Ephemeral all the way down — each PR gets a throwaway preview, built alongside a throwaway MicroVM:

- **Merge to `main`** → `deploy-pages` publishes `web/` to the production Pages site (gh-pages root).
- **Open/update a PR** → `pr-preview` publishes to `…/pr-preview/pr-<N>/` and comments the URL; **closing the PR tears it down**.
- **Every push/PR** → `mayfly-showcase` runs the fingerprint job on a `[self-hosted, mayfly]` runner (one MicroVM per run).

The Pages deploy injects `window.MAYFLY_API` from the repo variable `MAYFLY_DEMO_API` (mock mode if unset).

> **Fork PRs:** GitHub gives fork-PR workflows a read-only token and withholds secrets, so a fork PR can't
> publish a preview or post a receipt — but its checks still run in an isolated MicroVM (the isolation demo).
> Same-repo branch PRs get the full treatment. We deliberately avoid `pull_request_target` (a known footgun).

## Safety (it's a public button)

The public `/trigger` is bounded so it can't become a MicroVM faucet: a global **cooldown** in the API,
plus Mayfly's own **per-owner concurrency quota** and **fail-closed allowlist**. The job runs a fixed,
plain-shell workload — no user-supplied code.
