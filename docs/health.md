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
    name: Monkelytics Health
    unique_id: monkelytics_health
    resource: "http://gibbon.local:3300/health"
    method: GET
    scan_interval: 60
    timeout: 10
    value_template: >-
      {{ value_json.status | default('unknown') if value_json is defined else 'unknown' }}
    availability: "{{ value_json is defined and value_json.status is defined }}"
```

The sensor displays `ok` when the endpoint responds. A timeout makes the sensor
unavailable; it does not change the application's JSON to an error status.
On initial setup, Home Assistant waits for a successful connection before
creating the entity. Connection failures can therefore leave no sensor visible.
The availability template also rejects responses without a JSON `status` field.
For multiple installations, use a different `unique_id` for each sensor.
Check the Home Assistant configuration and restart Home Assistant to load it.
This example uses the built-in
[RESTful Sensor integration](https://www.home-assistant.io/integrations/sensor.rest/).

The example URL matches the test deployment on port 3300. A default Compose
installation uses port 3000; use the port published by your deployment. If you
already created the earlier `umami_health` entity, retain that `unique_id` and
rename the existing entity to Monkelytics Health in Home Assistant to avoid
creating a second sensor.

### IPv4 and IPv6 hostnames

A hostname can resolve to IPv4 or IPv6. Both paths must reach the published
port. On the tested Docker 20.10.5 host, an IPv4-only bridge published only an
IPv4 listener, even when an explicit IPv6 port binding was requested. The
`docker-compose.ipv6.yml` overlay enables IPv6 on the bridge and sets the
application listener to `::`, which accepts both address families.

Set `IPV6_SUBNET` in your deployment's `.env` to an unused private IPv6 /64.
This is an internal Docker network prefix, not the address of the server or a
replacement for its hostname. Use a distinct prefix per deployment. An explicit
prefix also supports older Docker engines without automatic IPv6 pool allocation.
Generate a prefix once, add the printed line to `.env`, and retain it for that
deployment:

```sh
python3 -c "import secrets; p='fd'+secrets.token_hex(5); print('IPV6_SUBNET='+':'.join(p[i:i+4] for i in range(0,12,4))+'::/64')"
```

```sh
docker compose -f docker-compose.yml -f docker-compose.ipv6.yml up --build -d
```

Changing an existing network requires recreating that project's containers and
network. Preserve the database volume: use `down` without `--volumes` before
starting it with the overlay. For the separate port-3300 test installation:

```sh
docker rm -f health-test-app  # Only when replacing the existing test application.
docker compose -p health-test down  # Retains the test database volume.
docker compose -p health-test -f docker-compose.yml -f docker-compose.ipv6.yml up -d --wait db
docker compose -p health-test -f docker-compose.yml -f docker-compose.ipv6.yml run --no-deps -d --name health-test-app -p 3300:3000 umami
curl --noproxy '*' -4 --fail http://gibbon.local:3300/health
curl --noproxy '*' -6 --fail http://gibbon.local:3300/health
```

Both requests must return `{"status":"ok"}`. Verify from another machine as
well as the Docker host; hostname resolution and network reachability can differ.

## Verification

Check the deployed response with:

```sh
curl --fail-with-body --include http://gibbon.local:3300/health
```

The request-level regression checks use Playwright's HTTP client and need no
browser or login. Against a running installation, run:

```sh
PLAYWRIGHT_SKIP_WEB_SERVER=1 PLAYWRIGHT_BASE_URL=http://gibbon.local:3300/ pnpm test:e2e tests/e2e/health.spec.ts
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
parsed as YAML. On 2026-09-15, the user confirmed that the live Home Assistant
sensor reports `ok`. The port-3300 deployment was then corrected for IPv6 and
verified from a separate Windows host using both `curl -4` and `curl -6` with
`gibbon.local`. Both returned HTTP 200 and `{"status":"ok"}`. Its PostgreSQL
volume was retained and startup reported no pending migrations.
The rest of the Playwright suite was not run for this change.

The first test container's logs showed about 13 seconds from container start to
application ready, including initial migrations. Image build time is separate;
the first build downloads dependencies and compiles the application.
