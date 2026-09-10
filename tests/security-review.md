# Security and workflow review

Status: focused implementation review completed on 2026-09-11. Validation used synthetic fixtures, SQLite in a temporary directory, and mocked model calls. No production deployment, paid model request, real customer import, or credential disclosure was performed by this review.

## Required boundaries

| Boundary | Focused acceptance check | Status |
|---|---|---|
| Authentication | No public signup; setup needs server secret; password hashing; username-bucket login limits; secure HttpOnly session; password reset removes sessions | Code reviewed; login, cookie, reset and administrator self-deactivation tests pass |
| Authorization and tenants | Entity reads/writes/exports/jobs/events require workspace access; global/assigned provider management is admin-only; viewers cannot mutate | Code reviewed; unauthorized, cross-workspace, viewer and provider-route tests pass |
| Secrets | Settings responses omit keys; assigned keys are encrypted at rest and selected server-side per requesting user | Dedicated-provider tests confirm secret omission, ciphertext storage and distinct keys in mocked execution |
| CSRF | Cookie-authenticated mutations reject foreign origins; trusted APP_ORIGIN handles a TLS reverse proxy; JSON content type required | Cross-origin rejection and external-origin/Secure-cookie tests pass |
| SSRF | Research URLs restrict schemes, IP ranges, ports and redirects; Node transport fixes the DNS-selected public destination; provider credentials have no automatic redirects | Code reviewed; research URL/IP tests pass; no live internal-network probe performed |
| Concurrency | Lead/advertiser saves use atomic version checks and snapshots; model result cannot overwrite a changed advertiser/lead snapshot | Delayed-response, stale-write, same-millisecond advertiser race and old-profile tests pass |
| Prompt injection and rendering | Material instructions are untrusted; tool set is constrained; React text rendering does not execute raw HTML; identity links and outreach require supported entity attribution | Code reviewed; source/identity/outreach research regression tests pass; model compliance is not mathematically guaranteed |
| Job cancellation and quotas | Cancellation checked before publishing; atomic daily reservation counts jobs and previews; interrupted work retains explicit status | Cancelled-output and concurrent shared-quota tests pass |

## Skill packaging checks

- Package includes only generic research instructions and references. No advertiser archive, real lead, source snapshot, personal contact or API credential is bundled.
- Grades are independent; identity level 1 does not admit candidate background into outreach; level 2/3 still require each referenced fact to pass attribution.
- Missing search/browser/OCR/storage abilities are disclosed instead of simulated.
- Names/regions generate business candidates only; no residential or sensitive personal profiling.
- Archive reuse and incremental changes preserve scope, evidence dates, conflicts, snapshot versions and correction history.

## Completed checks

- `quick_validate.py skills/overseas-lead-research`: passed using the available Python runtime with UTF-8 mode. The bundled runtime lacked PyYAML; no runtime or global dependency was changed.
- Read all five Skill files, confirmed the four linked references exist, and checked the package for advertiser/customer sample names and service credential markers. Only generic instructions are included.
- `vitest run`: **52 passed**, comprising 33 research tests and 19 security/integration tests.
- `tsc --noEmit`: passed.
- Provider assignment coverage: a new account is inactive; activation needs a validated configuration; test proof binds user and exact key/model fingerprint; proof cannot be reused after save; GET omits secrets; member imports and background research receive that member's assigned server-side key.

## Reproduced findings and corrections

1. Import previews were unmetered; jobs checked quota before a separate insert. Preview reservations now persist in `api_calls`, and preview/job count plus reservation is atomic. Failed attempts still consume the reservation; admin usage includes both sources.
2. Lead saves could read a later writer's value before recording history, losing a revision and attributing another edit to the wrong user. Update, snapshot and response revision now share one database batch.
3. A later invalid import row left earlier rows committed. All rows now validate before one atomic insertion batch.
4. Spoofed `CF-Connecting-IP` bypassed login attempt limits. The account bucket is independent of caller-supplied headers. A configured external origin also permits legitimate TLS-proxy requests while setting Secure cookies.
5. A finished research task could update current customer scores after its advertiser profile changed. Current-score update now checks both input revisions; the historical report remains available.
6. Provider middleware with a bare wildcard had no named user parameter and returned 404 for every assigned-provider operation. A named `/:id/*` middleware route fixed it; the full test/assign/activate/use path is exercised.
7. Advertiser history insertion used only a millisecond timestamp and could collide after a failed concurrent save. History now depends on the successful compare-and-swap, with the exact saved record returned from the same batch.

## Deployment limits

The primary Node runtime uses a pinned public transport for research and provider calls. The alternate Cloudflare implementation uses validation plus the platform network boundary; the separate DoH check is not DNS pinning. Do not describe the two network implementations as equivalent guarantees. HTTPS/proxy configuration, persistent volume permissions, backups and live multi-user operation must still be verified on the actual host. These synthetic tests do not replace live provider or deployment acceptance.
