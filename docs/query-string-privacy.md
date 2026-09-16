# Query-string privacy

The default is `preserve`: existing query, fragment, and campaign collection is
unchanged. The optional `allowlist` policy applies to future collection only.
It does not rewrite stored events, change visitor IDs, or add a migration.

In allowlist mode:

- Page queries retain only explicitly approved campaign parameters. With an empty
  allowlist, all page query parameters are removed.
- Referrer queries and all URL fragments are removed, including hash-based routes.
- URL usernames and passwords are removed from tracker payload URLs.
- Advertising click IDs are removed from queries and their dedicated columns.
- Page paths and referrer domains remain available for analytics.

Supported campaign names are `utm_source`, `utm_medium`, `utm_campaign`,
`utm_content`, and `utm_term`. Names are case-sensitive. Encoded names are decoded
before comparison; repeated approved parameters retain their order and values.
Values are not checked for personal information. Only approve fields whose
contents you control. For example, do not allow `utm_term` if it holds private
search terms.

## Configure the collection server

Merge these settings into the deployment's existing `.env`:

```dotenv
QUERY_STRING_POLICY=allowlist
QUERY_STRING_ALLOWLIST=utm_source,utm_medium,utm_campaign
```

Use an empty `QUERY_STRING_ALLOWLIST=` to discard every query parameter. The mode
accepts only `preserve` or `allowlist`; an explicitly empty or misspelled mode is
invalid. Unknown allowlist names, empty comma-separated entries, and a nonempty
allowlist with `preserve` are rejected at startup. Spaces around names are allowed.
Missing mode defaults to `preserve`; missing allowlist defaults to empty.

From the existing deployment directory, recreate the application after updating:

```sh
docker compose up --build -d --wait
```

Use `sudo` if required. Keep the existing project name, database volume, IPv6
overlay, port, and visitor rotation settings. For non-Docker deployments, set the
same variables in the environment of the server process.

The server policy applies independently of tracker settings, to pageviews and
custom events through `/api/send`, `/api/batch`, and existing link and pixel
collection handlers. Filtering precedes extraction of campaign and click-ID
columns. Performance collection already stores the pathname without its query.

## Configure the browser tracker

Add these attributes to each site's script tag, keeping its current tracker URL
and website ID:

```html
<script defer src="https://analytics.example.com/script.js" referrerpolicy="no-referrer"
  data-website-id="YOUR-EXISTING-WEBSITE-ID"
  data-query-string-policy="allowlist"
  data-query-string-allowlist="utm_source,utm_medium,utm_campaign"></script>
```

These attributes use the same validation and defaults as the server. Invalid
tracker configuration logs an error and disables that tracker instance rather
than sending unfiltered URLs. Omit the allowlist attribute to remove all query
parameters. Existing `data-exclude-search` and `data-exclude-hash` behavior still
applies to automatically collected URLs.

Filtering runs immediately before transmission, after manual payload overrides
and `data-before-send` callbacks. It also covers SPA navigation and identify and
performance payload URLs. An invalid URL stops that send. In allowlist mode the
collection fetch uses `referrerPolicy: 'no-referrer'` so its HTTP Referer header
does not disclose the current page's query to a same-origin collector.
The script tag's `referrerpolicy="no-referrer"` also prevents disclosure on the
request that loads the tracker, before the tracker code can run.

Configure **both** sides. Server environment variables do not rewrite the static
tracker or its embedding script tags. Old, cached, external, or unconfigured
trackers can still send raw values over the network; the enabled server policy
filters them before analytics persistence. Conversely, browser settings alone
cannot protect against direct API requests. Differing allowlists retain only
what survives both layers. Refresh cached tracker assets when rolling this out;
the existing script cache lifetime is up to one day.

## Scope and compatibility

Removing fragments merges hash routes into their common pathname. Removing
parameters can combine pages that differ only by query. Attribution reports lose
fields you no longer collect. Existing stored events remain available, so old
report values can still appear.

This is a URL query policy, not a general personal-data filter. Page titles,
pathnames, custom event/session properties, explicit `identify()` values,
recordings, and infrastructure logs are outside its scope. Requests can reach
proxies or logs before server-side filtering. Link redirects retain their
configured destinations; the policy filters their analytics data.

No deployment is switched to this policy automatically. To restore the default
for future events, set `QUERY_STRING_POLICY=preserve`, clear the server allowlist,
and remove the tracker privacy attributes. Removed data cannot be recovered.

## Verification

Unit tests cover defaults, exact and encoded names, duplicate parameters, empty
allowlists, invalid configuration, callback/manual payloads, and filtering before
event persistence for website, link, and pixel events.

Docker CI tests the default and enabled policy with Chromium, the built tracker,
real collection APIs, and PostgreSQL. It checks automatic pageviews, SPA
navigation, manual payloads, callbacks, an unconfigured tracker, and batch
ingestion. Assertions inspect request bodies, HTTP Referer headers, and stored
rows including campaign/click-ID columns. Invalid server configuration must exit
unsuccessfully without timing out. UTC-midnight and IPv6 checks remain enabled.

Integration tests require the disposable `monkelytics-ci` project. They must not
be run against an existing deployment.
