# Cloudflare Workers

Source for the three Cloudflare Workers that power the site's forms. They keep the
Airtable / Resend API keys off the public site — the browser POSTs JSON to a Worker,
and the Worker talks to Airtable/Resend using secrets stored as **Cloudflare bindings**
(never in this code).

> **Source of truth is Cloudflare.** These files mirror what's deployed (pulled
> 2026-06-07). If you edit a Worker in the dashboard, re-export it here so the repo
> stays in sync.

## Workers

| File | Deployed URL | Purpose |
|------|--------------|---------|
| `jjh-tasker-form.js` | `https://jjh-tasker-form.juniorjobhunt.workers.dev` | Tasker signup → normalizes city → writes to Airtable **Taskers** |
| `jjh-customer-form.js` | `https://jjh-customer-form.juniorjobhunt.workers.dev` | Customer request → writes to **Customers** → runs city matching → sends 3 emails via Resend → sets both records to "Matched" → logs to **Matches** |
| `jjh-waitlist-form.js` | `https://jjh-waitlist-form.juniorjobhunt.workers.dev` | Waitlist signup → validate + honeypot + KV rate-limit (5/IP/day) → writes to **Waitlist** |

## Bindings (set in Cloudflare, NOT in this repo)

| Worker | Bindings |
|--------|----------|
| `jjh-tasker-form` | `AT_BASE`, `AT_TOKEN` |
| `jjh-customer-form` | `AT_BASE`, `AT_TOKEN`, `RESEND_API_KEY` |
| `jjh-waitlist-form` | `AT_BASE`, `AT_TOKEN`, `RATE_LIMIT` (KV namespace) |

- `AT_TOKEN` / `RESEND_API_KEY` are secrets — keep them only as Cloudflare bindings.
- ⚠️ Deploying a Worker via the API **replaces ALL bindings** — always send the full
  binding set in the deploy metadata, or they get wiped.
- ⚠️ After regenerating any Airtable/Resend token, **re-deploy every Worker** that uses
  it (the old secret stays bound until you do).

## Deploying

These are ES module Workers (`export default { async fetch(request, env) }`). Deploy
with a multipart `PUT` to the Cloudflare API (`compatibility_date` 2026-04-24),
including the full `bindings` array in the metadata. See the team handoff doc for the
exact upload script and current binding values.
