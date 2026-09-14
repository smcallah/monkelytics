# Verification and deployment baseline

Recorded on 2026-09-14 against base commit
`ca661c7057984aa98ed4f7083d84dae2f65bfcb0` (Umami 3.3.1), with the stage 1
configuration changes in this checkout.

## Scope

This stage makes verification available in the fork and builds its application
from source. It does not change analytics, identity, privacy, API contracts,
authentication, database schema, or branding. PostgreSQL remains the only
service required alongside the application.

## Toolchain

- Node.js 22.13 or newer in the 22.x line; local verification used 22.23.2 on Windows x64.
- pnpm 11.21.0, pinned in `package.json` and matching the Dockerfile.
- PostgreSQL 15, as supplied by Compose.
- Docker verification used an ARM64 Linux host, Docker 20.10.5+dfsg1, and Compose 5.5.1 through sudo.

Use Node 22 for the baseline. The first test run with the host's Node 26.7.0
failed in browser-storage initialization: 13 files failed and 82 passed;
12 tests failed and 705 passed, with additional suites failing during import.
With Node 22, the same unmodified tests passed. No storage mocks, skipped tests,
or dependency changes were added to obtain that result.

## Commands

Install pnpm 11.21.0 if it is not already available, then run from the repository
root with Node 22 on PATH:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm lint
pnpm build
docker compose config --quiet
docker compose build
```

Prisma generation requires `DATABASE_URL` even when a command does not connect
to the database. Tests and typecheck can use the dummy URL below. Test and
typecheck lifecycle scripts generate the Prisma client; typecheck also generates
Next.js route types before running `tsc --noEmit`.

For an application build without a running database, CI and the local build
verification use the existing build-only option:

```sh
DATABASE_URL=postgresql://user:pass@localhost:5432/dummy SKIP_DB_CHECK=1 pnpm build
```

In PowerShell, assign those two environment variables through `$env:` before
running the command. This skips the database connection/migration stage, not
compilation or tests. A normal self-hosted build without `SKIP_DB_CHECK` connects
to `DATABASE_URL` and applies migrations. Docker builds use `build-docker`;
container startup performs the database check and migration instead.

Local verification invoked the downloaded pnpm CLI with a portable Node 22
runtime because the host's default Node and bundled pnpm launcher used different
runtime versions. An initial sandboxed install could not access npm; the
network-enabled frozen install succeeded without changing the lockfile.

## Results

| Check | Baseline and final result |
| --- | --- |
| Frozen dependency installation | Passed; lockfile unchanged. |
| Unit/component tests | Passed before and after configuration changes: 95 files, 739 tests. |
| TypeScript | Passed. Initial direct `tsc --noEmit` and the final `pnpm typecheck` reported no errors. |
| Lint | Stage 1 initially retained 1 existing error, 13 warnings, and 11 informational diagnostics. The verification follow-up fixed the error; lint now exits successfully with the same warnings and informational diagnostics. |
| Application build | Passed with the existing build-only database option, including tracker, recorder, GeoLite database, and production Next.js output. |
| Compose configuration | Passed on the Docker host. |
| Docker image | Passed on Linux ARM64 after enforcing LF shell-script endings. Dockerfile unchanged. |
| PostgreSQL runtime | Passed: all 24 migrations applied, login and tracker served, website created, pageview stored and queried, and data retained after application restart. |

The initial image built but exited at startup with
`scripts/start-docker.sh: set: line 11: illegal option -` because the Windows
export contained CRLF endings. The committed script already used LF; no Git
attribute protected that convention in Windows checkouts. The final image used
the committed LF script contents and started successfully. `.gitattributes`
now enforces the same shell-script endings for future checkouts.

The verified final image ID is
`sha256:88514fc6bfd878b7b95b44e9981b1e5634c34678c999d4a9cab54b39093d2cfa`.
It runs as `nextjs`. The runtime smoke test used a separate Compose project and
a fresh PostgreSQL volume, with no published application ports. It checked
`/api/heartbeat`, `/login`, `/script.js`, login/logout, website creation, one
synthetic pageview through `/api/send`, and the website statistics API. Results
were one pageview, one visitor, and one visit, both before and after restart.
The second startup reported no pending migrations, and container health was
`healthy`. The disposable containers, network, and database volume were removed
after verification; the image and build logs were retained for inspection.

Runtime commands used the isolated project name with `docker compose up -d
--wait db` and `docker compose run --no-deps -d --name <test-container> umami`.
The latter does not publish the service ports. A temporary Node assertion script
ran through `docker exec -i`, followed by `docker restart` and a read-back check.
Cleanup used `docker compose down --volumes --remove-orphans` only for that
disposable project, followed by explicit removal of its one-off application
container and network, which Compose left behind. No existing deployment was
removed. Project-label checks confirmed no test containers, volumes, or networks
remained.

The original lint error was `lint/correctness/useHookAtTopLevel` in
`src/app/not-found.tsx`: the anonymous default-exported function calls
`useMessages`. The verification follow-up names that component `NotFound`, which
lets Biome recognize it as a React component without changing its rendered output.
Other lint diagnostics include unused imports/variables, style issues, a Biome configuration
schema-version mismatch, and a deprecated configuration field. No autofix or
rule suppression was applied.

The existing Next.js `typescript.ignoreBuildErrors` setting remains unchanged.
The independent typecheck command and CI job report TypeScript failures with
their original nonzero exit status. Build success alone is not the typecheck
result.

The full Playwright suite was not run. It creates, updates, and deletes data and
requires a disposable running installation. Its configuration is Playwright;
the older test-convention README still refers to Cypress.

## CI behavior

`.github/workflows/ci.yml` runs on pushes, pull requests, and manual dispatches,
using standard GitHub-hosted Ubuntu runners. The upstream repository restriction
is removed. Tests, typecheck, lint, and build run as separate matrix jobs, with
fail-fast disabled so every result remains visible. A separate job validates
Compose and builds the image without publishing it.

The original lint error has been fixed. There is no `continue-on-error`,
ignored command status, or lint suppression. The verification follow-up confirmed
that GitHub Actions is enabled and the CI workflow is active.

### Verification follow-up: 2026-09-14

Commit `fe10f705a66d32d5c24660fcc9ac5c870d6cf620` names the `NotFound` component.
Local verification on Node 22.23.2 and pnpm 11.21.0 passed:

- `pnpm lint --max-diagnostics=100`: exit 0, with 13 existing warnings and 11 informational diagnostics.
- `pnpm test`: all 95 files and 739 tests passed.
- `pnpm typecheck`: exit 0, no TypeScript errors.
- `pnpm build`: exit 0 using the existing dummy database URL and `SKIP_DB_CHECK=1`.

[GitHub Actions run 34884650620](https://github.com/smcallah/monkelytics/actions/runs/34884650620)
passed all five jobs on that commit: tests, typecheck, lint, application build,
and Docker build/Compose configuration. Each Node job installed dependencies
with `pnpm install --frozen-lockfile`. The Docker job validated Compose and built
the application from source on the GitHub-hosted Linux runner.

The initial successful run was started with
`gh workflow run ci.yml --repo smcallah/monkelytics --ref master`. Normal pushes
were still blocked by GitHub's fork-wide Actions activation gate. The repository
permissions API reported `enabled: true`, and the workflow API reported `active`,
but the Actions page still displayed "Workflows aren't being run on this forked
repository." Enabling the individual workflow through `gh workflow enable` did
not clear that gate. A fresh branch push reproduced the missing-run behavior.

The gate was cleared on the repository's Actions page using "I understand my
workflows, go ahead and enable them"; GitHub then confirmed "Actions Enabled."
This is the fork activation step described in the
[GitHub event documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflows-in-forked-repositories).
Git and the GitHub CLI both authenticated as the repository owner using the same
OAuth credential; the cause was not an Actions `GITHUB_TOKEN` push.

Only `ci.yml` is active. The inherited `cd.yml`, `cd-cloud.yml`, and
`stale-issues.yml` workflows were kept disabled so activation does not publish
images or modify issues. These are repository settings; their workflow files
were not changed. No analytics code, dependency versions, test expectations, or
lint rules changed during this trigger investigation.

An ordinary `git push origin master` of commit
`29ca8d3c0e3e99ba35c13714c8a6727ad1f51c4d` automatically started
[CI run 34886827906](https://github.com/smcallah/monkelytics/actions/runs/34886827906).
GitHub reports its event as `push`, confirming that fork activation restored the
automatic trigger without a manual dispatch or workflow-code change.

## Self-hosting

Compose now builds the current checkout's Dockerfile instead of pulling an
upstream Umami application image:

```sh
docker compose up --build -d
```

The application service name, PostgreSQL service, database settings, and named
database volume are preserved. Rebuilding the application does not delete that
volume. Do not use `docker compose down --volumes` on an installation whose data
you need to keep. Replace the supplied example secrets before deployment.

The application healthcheck still calls `/api/heartbeat`, now with curl's HTTP
failure checking enabled. This remains a liveness check; no new endpoint or
database-readiness behavior was added.

`.dockerignore` excludes local dependency/build outputs and logs so Windows
artifacts do not enter the Linux build. `.gitattributes` requires LF endings for
shell scripts so the container entrypoint is executable by `/bin/sh` when the
checkout is prepared on Windows. The script's commands are unchanged.

Existing image-build limitations remain: the Node/PostgreSQL image tags are
floating, runtime helper dependencies are installed separately in the Dockerfile,
and the GeoLite build downloads external data. The successful build establishes
that this source can build with the tested inputs; it does not make every input
immutable. The image-publishing workflows are outside this stage's scope.
