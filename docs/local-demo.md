# Local demo website

The optional demo serves three pages and a custom-event button on port 3301.
It uses the actual browser tracker and a separate website record, so demo traffic
does not mix with other sites. No analytics application or database code changes
are needed. The additional container runs a small Node HTTP server using the
existing application image; it does not run another analytics instance.

## Setup

1. In Monkelytics, create a website named **Monkelytics Demo**, using the hostname
   visitors will use (for example, `gibbon.local`). Copy its website ID.
2. Keep your existing `.env` settings and append `:docker-compose.demo.yml` to
   its `COMPOSE_FILE` value. Retain the IPv6 overlay if your deployment uses it.
3. Add these values, using your own website ID and application image name:

```dotenv
DEMO_WEBSITE_ID=YOUR-WEBSITE-UUID
DEMO_ANALYTICS_URL=http://gibbon.local:3300
DEMO_IMAGE=health-test-umami
DEMO_PORT=3301
QUERY_STRING_POLICY=allowlist
QUERY_STRING_ALLOWLIST=utm_source,utm_medium,utm_campaign
```

`DEMO_ANALYTICS_URL` must be reachable by the visitor's browser, not just by the
containers. `docker compose images` shows your current application image name.
The website ID is a public tracker identifier, not an authentication secret.
The analytics server policy applies to every site on that instance: review this
choice if other websites are already using it. Existing rows remain unchanged.

Then run from the existing deployment directory:

```sh
docker compose config --quiet
docker compose up --no-build --no-deps -d --wait umami demo
```

Use `sudo` if required. The analytics container is recreated only if its settings
changed. Keep the same project name and database volume. The demo uses the same
Compose network and listens on `::`, supporting IPv4 and IPv6 with the existing
IPv6 overlay. No public DNS, router forwarding, or internet exposure is needed.

## Try it

- Open `http://gibbon.local:3301` from a device on your LAN.
- Open the dashboard with the link in the header; sign in as usual.
- Browse Home, Explore, and About. Check pageviews and Realtime for the demo site.
- Click **Try a sample event**. Look for `demo_button_click` in Events. Its
  properties contain only a fixed button name and the page pathname.
- Follow **Try the privacy link**. It uses synthetic test values. The approved
  UTM fields survive; the dummy email, click ID, and fragment should not appear
  in the recorded URL or click-ID columns when the server policy is enabled.

The demo enables browser query filtering and suppresses HTTP Referer headers.
It does not use `identify()`, forms, cookies, or session recording. Server filtering
must be enabled separately as above; see [query privacy](query-string-privacy.md).
The status text reports tracker loading and event requests, not proof of database
delivery. Use the dashboard or collection response to confirm delivery.

The demo server serves only known routes and assets, has no access logging, and
exposes `/health` for its container healthcheck. It runs with a read-only root
filesystem, a read-only demo mount, and no added Linux capabilities.

## Stop or update

Use `docker compose stop demo` to stop just the demo. Do not remove database
volumes. After updating demo files, use `docker compose restart demo`: assets are
loaded when its server starts. Recreate it with `docker compose up --no-build
--no-deps -d --wait demo` after changing its environment settings.

Deployment verification creates a small amount of real demo traffic. That traffic
is intentionally retained so the dashboard is populated when you first open it.
