# Anonymous collection policy

`COLLECTION_MODE=anonymous` disables the collection API's explicit identity
mechanism and uses server receive time for new events. The default is `standard`,
which preserves Umami identification and historical timestamp behavior.

| Behavior | `standard` (default) | `anonymous` |
| --- | --- | --- |
| `identify()` requests | Existing identity and session-property writes | HTTP 403; no lookup or persistence |
| Explicit event `payload.id` | Existing behavior | Ignored before persistence |
| Supplied `payload.timestamp` | Existing historical event behavior | Ignored; use request arrival time |
| Visitor ID calculation | Existing calculation | Separate anonymous namespace |
| Cached identity link | Existing behavior | Removed from the returned token |
| Custom events and performance | Existing behavior | Preserved with receive-time timestamps |

The policy applies to `/api/send` and each item sent through `/api/batch`.
An anonymous batch can contain accepted events and rejected identification
requests. Its response reports rejected indexes in `details`; HTTP 200 for the
batch does not mean every item was accepted. Standard mode remains available
for historical imports. There is no public request flag that bypasses the
server's anonymous policy. An anonymous installation cannot backdate imports.

## Configure the server and tracker

Merge these settings into your existing deployment environment:

```dotenv
COLLECTION_MODE=anonymous
SALT_ROTATION=day
QUERY_STRING_POLICY=allowlist
QUERY_STRING_ALLOWLIST=utm_source,utm_medium,utm_campaign
```

These are independent policies. Anonymous mode does not change the rotation
default: set `SALT_ROTATION=day` for midnight UTC rotation. See
[daily rotation](daily-rotation.md) and [URL query privacy](query-string-privacy.md)
for their behavior and reporting limits.

After updating the source, rebuild and recreate the application with your
existing Compose project, secrets, port, IPv6 overlays, and database volume:

```sh
docker compose up --build -d --wait
```

A restart alone does not apply changed environment settings. For a standalone
installation, set the variables in the server process environment. Invalid or
empty `COLLECTION_MODE` values stop server startup; only the two lowercase values
in the table are accepted. No database migration is required.

On each tracked site, configure the script using its actual URL and website ID:

```html
<script defer src="https://your-analytics-host/script.js"
  data-website-id="YOUR-WEBSITE-UUID"
  data-collection-mode="anonymous"
  data-query-string-policy="allowlist"
  data-query-string-allowlist="utm_source,utm_medium,utm_campaign"
  referrerpolicy="no-referrer"></script>
```

The tracker drops `id` and `timestamp` after manual overrides and before-send
callbacks, immediately before transmission. `identify()` resolves without
sending a request, calling the callback, or retaining an identity. Invalid
tracker mode values disable tracking with a configuration diagnostic. Without
the attribute, the tracker retains its existing behavior.

Configure both sides. The server protects stored analytics even when old
trackers or direct callers send explicit IDs and timestamps. The tracker stops
those fields reaching the server. Refresh cached tracker assets after rollout;
their existing cache lifetime can be one day.

## Compatibility and privacy limits

Switching modes creates different visitor IDs even within the same rotation
period. Existing signed tokens cannot make anonymous events join an identified
standard-mode session. Existing events, identity links, and sessions remain in
the database. Reports spanning the switch can count the same person more than
once. Returning to standard mode resumes its existing ID calculation; it does
not merge or remove anonymous records.

Receive time is sampled at the beginning of each collection request, before
asynchronous parsing, lookup, or detection. A batch samples each item separately,
so a batch spanning midnight can contain events from two days. Supplied past,
future, and zero timestamps cannot select a different day or bypass visit expiry
in anonymous mode. Delayed and offline events are recorded at arrival time.

This policy limits the built-in identity API. It is not a general personal-data
filter or a guarantee of unlinkability. Free-form event properties, event names,
titles, pathnames, tags, session recordings, other APIs, and infrastructure logs
remain separate privacy surfaces. Do not send personal data through those fields.
Payload IP/user-agent overrides and trusted proxy configuration retain their
existing behavior and need a separate ingestion-policy review. Raw IPs remain
inputs to hashing/location checks and are not added to analytics storage.
Deterministic hashes and retained application secrets do not provide daily
secret destruction. Shared IP/user-agent combinations can merge visitors, and
changes to those inputs can split a visitor.

## Verification

Regression tests cover identify rejection before side effects, explicit-ID
removal for website/link/pixel events and both persistence branches, receive-time
selection across UTC midnight, ignored timestamps and visit expiry, removal of
cached identity state, mode-switch isolation, and standard import compatibility.
Tracker tests cover manual and callback overrides, suppressed identification,
standard behavior, and invalid configuration.

The disposable Docker CI installation verifies the built tracker, HTTP APIs,
and PostgreSQL. It checks an old tracker's rejected identify call and subsequent
events across midnight, direct and performance requests with historical
timestamps, mixed batch results, browser filtering after callbacks, and absence
of explicit identities and session-property writes. Startup checks reject empty
and invalid server modes. The integration overlay must never be used on a real
deployment.
