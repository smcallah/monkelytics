# Visitor identity review

Reviewed on 2026-09-15 against the PostgreSQL collection path. This change adds
tests and documentation only. Monthly rotation remains the default; application
code, deployment settings, database schema, and stored data are unchanged.

## What already exists

The browser tracker keeps its cache token and optional explicit identity in
memory. It sends the token as `x-umami-cache` on subsequent requests. The tracker
does not persist that identity in cookies or browser storage. Its localStorage
read is for the `umami.disabled` opt-out setting; fetch credentials default to
`omit`, with an existing configuration override.

[`src/app/api/send/route.ts`](../src/app/api/send/route.ts) recomputes `sessionId`
for every request from the website/link/pixel ID, client IP, user-agent string,
and calendar salt. [`src/lib/crypto.ts`](../src/lib/crypto.ts) hashes these inputs
with a secret derived from `APP_SECRET`, falling back to `DATABASE_URL`, then
produces a UUIDv5. Identical inputs in one rotation period produce the same ID,
including after a page reload. Different websites produce different IDs.

Despite its name, `sessionId` supplies the visitor count. `visitId` is a separate
value derived from the session ID and an hour salt. The
[`session statistics query`](../src/queries/sql/sessions/getWebsiteSessionStats.ts)
counts distinct session IDs as visitors and distinct visit IDs as visits.

`SALT_ROTATION` supports `day` and `week`; all other values use a month. Missing
configuration defaults to `month`. These periods start in the server's local
timezone. Converting the start date to a UTC string does not make the boundary
UTC. The browser timezone and dashboard timezone do not select the boundary.
The Compose files currently do not pass `SALT_ROTATION` into the application;
putting that variable in `.env` alone would not enable daily rotation there.

On a changed session ID, a website request creates the PostgreSQL session before
writing its event or session data, replaces the visit ID, and resets the cache
issue time. A signed token from yesterday therefore does not pin an anonymous
website visitor to yesterday's ID. The token carries identifiers and an issue
time, but collection does not give it an expiry time.

## Findings before changing the default

| Finding | Evidence | Consequence / next action |
| --- | --- | --- |
| Daily rotation works at server-local midnight, including a live cached session. | Route and crypto tests pass in UTC, America/New_York, and Asia/Kathmandu. | Use an explicit UTC day boundary for a future daily mode so hosts agree. Keep weekly/monthly compatibility deliberate. |
| A supplied event timestamp chooses the identity period. | Route test reproduces an old day's ID when the request arrives two days later. | Define browser receive-time behavior separately from historical imports before claiming old IDs cannot be reused. |
| Explicit identity links survive daily rotation. | Two `identify` requests across midnight write the same `distinctId` against different session IDs. `session_link` queries can retrieve both. | Daily pseudonymous IDs alone do not make explicit identification anonymous. Decide the policy for anonymous mode without silently breaking existing identify users. |
| The calendar salt is deterministic and retained application secrets allow old IDs to be recomputed for known inputs. | `getSalt`, `secret`, and `uuid` source inspection. | Describe this as periodic pseudonymous identification, not guaranteed permanent unlinkability or daily secret destruction. |
| Cached website IDs are not compared with the requested website ID before skipping website lookup. | Source inspection of the cache acceptance and lookup branches in `POST`. | Add a focused cache-scope fix and rejection/fallback tests before relying on tokens for website isolation. This review does not claim an end-to-end exploit reproduction. |
| Cache tokens have no automatic expiry. | The returned token has no `exp` claim; collection only checks its signature and type. | Define token age and website revalidation separately; ID recomputation already handles normal day rollover. |
| The 30-minute visit refresh can retain its visit ID within the same clock hour. | A real-token test at 09:00 and 09:30:01 returns the same visit ID with a refreshed issue time. | This is an existing visit-semantics limitation, separate from daily visitor rotation. |
| Invalid rotation values silently use monthly rotation. | `daily` and `month` produce the same salt in a characterization test. | Validate configuration when adding the daily default. |

IP or user-agent changes can split one visitor within a day. Different visitors
sharing the same IP and user-agent can share an ID. Native IPv6 address changes
can also split visitors; this design does not identify physical devices. Changing
`APP_SECRET`, or the database URL when it supplies the fallback secret, also
changes IDs and invalidates existing cache tokens.

## Raw IP handling and limits of this review

[`src/lib/detect.ts`](../src/lib/detect.ts) uses the IP in memory for location,
blocking, and ID generation. A payload IP overrides the proxy-header result;
the header path uses [`src/lib/ip.ts`](../src/lib/ip.ts), which includes IPv6 and
IPv4-mapped IPv6 normalization. Payload overrides and trusted proxy header
configuration need their own ingestion-policy review.

The ordinary collection test verifies that the raw IP is absent from arguments
passed to `createSession` and `saveEvent` and from the decoded cache token.
The PostgreSQL `Session` schema and ordinary event persistence have no raw-IP
field. This is not a guarantee that an IP can never be stored anywhere: custom
event data, explicit identities, URLs, upstream access logs, and serialized
errors are separate input/logging paths. They were not comprehensively audited
in this milestone. No live database contents or host logs were audited here.

## Recommended next implementation

1. Bind accepted cache tokens to the requested website, with regression tests
   proving a token from site A cannot skip validation of site B.
2. Implement and test an explicit UTC day boundary for daily mode. Preserve
   existing weekly/monthly behavior unless separately changed. Validate the
   rotation setting and expose it through Compose.
3. Decide how anonymous mode handles explicit identities and supplied event
   timestamps. Document the resulting privacy limits and import compatibility.
4. Enable the daily default only with those boundaries defined. Test open tabs
   across midnight through the actual tracker, HTTP server, and PostgreSQL, and
   verify that daily visitor counts change as documented.

A daily default increases distinct visitor IDs over multi-day reports; one
person visiting on three days can count as three visitors. Existing rows should
remain intact. The rollout must document the change in reporting semantics and
must not describe switching back to monthly rotation as restoring prior counts.
No new infrastructure is needed for these steps. Query-string privacy and
branding remain separate work.

## Verification

The existing focused baseline was 62 passing tests across the collection route,
crypto helpers, and session tests. This review adds 23 cases. The expanded 85
tests pass in each of UTC, America/New_York, and Asia/Kathmandu. Cases include
same-day stability, local midnight, month/year/leap-day boundaries, US DST days,
signed-cache rollover for events/identify/performance, website separation,
changed client inputs and secrets, historical timestamps, and identity linkage.

The full local suite passes: 762 tests across 95 files. Typecheck passes. Lint
passes with the existing 13 warnings and 11 informational diagnostics. Frozen
dependency installation with pnpm 11.21.0 also passes. Initial local script
launches stopped before tests because pnpm required a dependency refresh and
Prisma generation lacked `DATABASE_URL`; reruns used noninteractive installation
and the same dummy database URL as CI. No test assertions were disabled.

One existing visit-expiry test used a mismatched cached session, so it could
pass through session-drift handling without exercising expiry. It now supplies
the matching session ID and actually reaches the visit-expiry branch.

These are route-level tests using real hashing and JWT signing/verification,
with request parsing, client detection, and database writes mocked. They do not
replace a real browser/PostgreSQL midnight test. No deployment was changed.
Tests that describe current limitations are characterization checks, not a
promise to preserve those limitations when their fixes are implemented.

Run the focused checks with the repository's pinned pnpm and Node.js versions:

```sh
for timezone in UTC America/New_York Asia/Kathmandu; do
  TZ="$timezone" pnpm exec vitest run src/app/api/send/route.test.ts src/lib/crypto.test.ts src/lib/session.test.ts
done
```

On PowerShell, set `$env:TZ` before each command and restore its prior value
afterward. CI runs the same timezone checks in addition to the complete suite.
