# Health monitoring

`GET /health` is an unauthenticated liveness endpoint. A running application
returns HTTP 200, `Content-Type: application/json`, and `Cache-Control: no-store`:

```json
{"status":"ok"}
```

It does not access PostgreSQL, authenticate a user, create a session, or collect
an analytics event. HTTP 200 means the application can answer this request; it
does not mean that database access or event ingestion is working. The endpoint
remains available during a database outage after the server has started. Normal
Docker startup still requires its existing database check and migrations.

`HEAD /health` returns the same status and cache policy with an empty body.
`POST /health` returns HTTP 405. The existing `/api/heartbeat` endpoint and Docker
Compose healthcheck retain their existing behavior.

If the application was built with `BASE_PATH=/analytics`, include that prefix:
`/analytics/health`. Configure any reverse proxy to pass this endpoint through
without caching its response. A proxy with its own authentication can still
require credentials even though the application endpoint does not.

## Home Assistant

Add this sensor to `configuration.yaml`, or merge the item into an existing
`sensor:` list. Replace the example address with one reachable from Home
Assistant. Use the application's configured base path when applicable.

```yaml
sensor:
  - platform: rest
    name: Umami Health
    unique_id: umami_health
    resource: "http://analytics-host:3000/health"
    method: GET
    scan_interval: 60
    timeout: 10
    value_template: >-
      {{ value_json.status | default('unknown') if value_json is defined else 'unknown' }}
    availability: "{{ value_json is defined and value_json.status is defined }}"
```

The sensor displays `ok` when the endpoint responds. A timeout makes the sensor
unavailable; it does not change the application's JSON to an error status.
The availability template also rejects responses without a JSON `status` field.
For multiple installations, use a different `unique_id` for each sensor.
Check the Home Assistant configuration and restart Home Assistant to load it.
This example uses the built-in
[RESTful Sensor integration](https://www.home-assistant.io/integrations/sensor.rest/).

## Verification

Check the deployed response with:

```sh
curl --fail-with-body --include http://analytics-host:3000/health
```

The request-level regression checks use Playwright's HTTP client and need no
browser or login. Against a running installation, run:

```sh
PLAYWRIGHT_SKIP_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://localhost:3000/ pnpm test:e2e tests/e2e/health.spec.ts
```

On PowerShell, set these variables with `$env:` before running the command.
For a base path, include it and a trailing slash in `PLAYWRIGHT_BASE_URL`.
The checks cover public JSON access, cache prevention, HEAD, POST rejection, and
the existing heartbeat response. They do not modify application data.

CI runs these checks against the built standalone server in the application-build
job. Its database URL points to an unavailable dummy database, so this also
checks that liveness does not depend on a database connection.

Verified on 2026-09-14: frozen dependency installation, all 739 existing tests
across 95 files, typecheck, lint, and the production build passed. Lint retains
13 existing warnings and 11 informational diagnostics. All four health HTTP
tests passed against the local production server with an unreachable database.
The ARM64 Docker build and Compose validation passed on the test host; the HTTP
contract also passed before and after stopping its disposable PostgreSQL
container. The test deployment was removed afterward.

The Home Assistant example was checked against its official documentation and
parsed as YAML. It has not been installed in a live Home Assistant instance.
The rest of the Playwright suite was not run for this change.
