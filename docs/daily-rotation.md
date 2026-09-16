# Visitor rotation configuration

Monthly visitor rotation remains the default. Daily rotation is available as an
explicit setting; it now changes visitor IDs at **00:00 UTC**, independently of
the server, browser, or dashboard timezone. Weekly and monthly modes retain their
existing server-local calendar boundaries.

| `SALT_ROTATION` | Boundary |
| --- | --- |
| Unset | Monthly, server-local start of month |
| `month` | Server-local start of month |
| `week` | Existing server-local start of week |
| `day` | Midnight UTC |

Only these three lowercase values are accepted. Empty values, whitespace, and
misspellings such as `daily` cause application startup to fail with
`SALT_ROTATION must be one of: day, week, month.` The same validation protects
salt generation. Next.js's server initialization hook performs the startup
check for Docker, standalone, and Next.js server runs.
On Node.js, invalid configuration exits with status 1: throwing from the hook
alone can leave Next.js's listener alive even though server initialization failed.

## Docker Compose

The base Compose file now passes `SALT_ROTATION` into the application, defaulting
to `month` when absent. To opt into daily rotation, merge this line into your
deployment's existing `.env`:

```dotenv
SALT_ROTATION=day
```

From the existing deployment directory, after updating to the version containing
this change, build and recreate the application:

```sh
docker compose up --build -d --wait
```

Use `sudo` if your host requires it. Retain the existing Compose project name,
IPv6 overlay, port, secrets, and database volume. A plain container restart does
not apply changed environment settings. No database migration is introduced.

For a non-Docker server, set the same environment variable in the process that
starts the application. Leaving it unset preserves monthly rotation.

## Compatibility and privacy limits

An existing daily-mode installation on a non-UTC server changes its salt when
upgraded, so some visitors can receive a new ID immediately. Existing daily mode
on a UTC server retains its salt calculation. Weekly/monthly modes retain their
calculation; previously ignored invalid values must be corrected before upgrade.
Existing database rows are not rewritten.

Daily mode counts a returning person as separate visitors on different UTC days.
Consequently, multi-day visitor totals differ from monthly-mode totals. Returning
to monthly mode does not merge visitor IDs already stored during daily mode.

This setting changes pseudonymous visitor IDs, not the explicit identification
API. `identify()` values can still link sessions across days, and supplied event
timestamps still select their historical identity period. The calendar salt is
deterministic; this is not daily secret destruction or guaranteed unlinkability.
See the [identity review](visitor-identity-review.md) for remaining policy work.

## Verification

Unit tests check UTC midnight, month/year/leap-day boundaries, DST dates, fixed
UTC salt values, input-date preservation, configuration rejection, cached-session
rollover, and unchanged weekly/monthly calculations. CI runs these tests in UTC,
America/New_York, and Asia/Kathmandu.

The Docker job first checks normal startup and network recreation with the
monthly default, then verifies that invalid and empty settings fail startup.
It uses a test-only Compose overlay for the browser/PostgreSQL test:

- The server runs with `SALT_ROTATION=day` and `TZ=America/New_York`.
- A Chromium page loads the built tracker from the running application.
- The same page sends events at 23:59:59 UTC, 00:00:00 UTC, and New York midnight.
- The test confirms the tracker sends its previous cache token, the visitor and
  visit IDs change at UTC midnight, and the visitor ID stays stable at New York
  midnight.
- Direct PostgreSQL reads verify all three events and their associated session
  rows, IDs, and timestamps.

Only the disposable `monkelytics-ci` project is permitted by this test. A Node.js
preload mounted by `tests/integration/compose.yml` controls the test server's
clock. It is not included in the runtime image or loaded by the normal Compose
configuration. No application clock-control endpoint or host-clock change is
used. The browser sends ordinary tracker events without timestamp overrides.

The integration test is run by CI with:

```sh
pnpm exec playwright test --config tests/integration/playwright.config.ts
```

It requires CI's disposable Compose setup and installed Chromium; it is not a
command to run against an existing deployment.
