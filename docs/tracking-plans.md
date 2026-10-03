# Declared tracking plans

An optional `analytics.yaml` declares custom events and their scalar properties
for existing website IDs. A deployment operator assigns the plans by mounting
the file and setting `ANALYTICS_MANIFEST_PATH`. Collection and generated helpers
use the same declarations. This stage adds no database table, migration, or service.

Sites absent from the file retain ordinary Umami dynamic events. Plans apply
only to named custom events with `payload.website`; pageviews, performance,
identification, link events, pixel events, and recordings keep their existing
policies. [Anonymous collection](anonymous-collection.md) remains independent.

## Manifest format

The repository's [analytics.yaml](../analytics.yaml) is an example and is not
loaded automatically. Replace its IDs with your existing website IDs:

```yaml
version: 1
websites:
  11111111-1111-4111-8111-111111111111:
    mode: observe
    events:
      demo_button_click:
        properties:
          button: {type: string, required: true}
          page: {type: string}
      ready: {}
```

Each website key must be its lowercase UUID. IDs are compared case-insensitively
on collection. An assignment does not create a website or change its ownership.
The operator must obtain the correct ID from website settings. Only administrators
with access to the server's deployment files can change this configuration;
public collection requests and dashboard users cannot edit it. Existing
dashboard and website management permissions are retained.

`mode` defaults to `observe`. Use `reject` explicitly after reviewing drift.
`properties` defaults to an empty mapping. Types are `string`, `number`, and
`boolean`; `required` defaults to `false`. Required properties must be present
with the declared type. Null, arrays, objects, and numeric strings do not match
these scalar types. Numbers must be finite. Strings above 500 JavaScript string
units are reported before Umami's existing storage truncation. Other numeric
storage precision and rounding retain Umami behavior.

Event names start with an ASCII letter and contain letters, digits, underscores,
hyphens, or periods, up to 50 characters. Property names start with a letter or
underscore and contain letters, digits, or underscores, up to 50 characters.
`__proto__`, `constructor`, and `prototype` are reserved. Undeclared properties
are reported; they are not silently removed.

Version 1 supports one YAML document, no aliases, and no custom tags. Duplicate
keys, unknown configuration fields, invalid website IDs, and unsupported types
are errors. Limits are 256 KiB per file, 100 websites, 200 declared events per
website, and 50 properties per event. `websites: {}` is valid and removes all
assignments after restart. Arrays, nested property schemas, enums, and value
constraints are outside this version.

## Validate and generate

Use the supported Node 22 and pinned pnpm from the source checkout:

```sh
pnpm analytics validate analytics.yaml
pnpm analytics generate analytics.yaml --website-id 11111111-1111-4111-8111-111111111111 --out src/analytics.ts
pnpm analytics check analytics.yaml --website-id 11111111-1111-4111-8111-111111111111 --out src/analytics.ts
```

Validation errors include `filename:line:column` and a field path. A missing field
uses the nearest available parent location. Commands exit unsuccessfully on
invalid input, missing files, invalid flags, undeclared website IDs, or stale
generated output. Generation validates before writing and replaces the helper
atomically; a failed generation preserves the previous helper and manifest.
Create the output directory first. `check` accepts CRLF or LF endings but compares
the rest exactly. Regenerate after changing declarations; avoid manually editing
or reformatting generated files. Event/property order is deterministic.

Generated helpers have no package dependency. Load the usual tracker script,
then bind the helper:

```ts
import { createAnalytics } from './analytics';

const track = createAnalytics(window.umami);
await track('demo_button_click', { button: 'sample', page: '/about' });
await track('ready');
```

The helper fixes the website ID and calls the existing tracker through its
payload callback, preserving the current URL, title, screen, language, referrer,
and other ordinary page context. Declared event names, required properties, and
property types are checked by TypeScript. Ordinary JavaScript callers, pre-send callbacks, manual
requests, and untyped data can still drift; server validation handles those
requests. The helper does not add a runtime client validator, await tracker
loading, or change the existing tracker's HTTP-error handling. Use collection
responses or the dashboard to confirm delivery. Generate one helper per site.

## Server deployment

Validate a separate deployment copy of the manifest first. Start in `observe`
mode, and retain your current Compose project, database volume, secrets, port,
and any IPv6/demo overlays. Append `docker-compose.analytics.yml` to the existing
`COMPOSE_FILE` setting and set the absolute host path:

```dotenv
ANALYTICS_MANIFEST_FILE=/absolute/path/to/analytics.yaml
```

The optional overlay mounts that file read-only at
`/tracking-plan/analytics.yaml` and sets `ANALYTICS_MANIFEST_PATH` accordingly.
The path is required only when using this overlay. Missing source files are not
created as directories. The manifest must be readable by the container user
(normally UID 1001). Do not include credentials or visitor data in the file.
The example is excluded from the Docker build context and is not baked into
the production image.

After updating the application source:

```sh
docker compose config --quiet
docker compose up --build -d --wait
```

For a standalone server, set `ANALYTICS_MANIFEST_PATH` to the file path in its
process environment. Unset or empty values disable plan loading. A configured
missing, unreadable, oversized, or invalid file stops startup; it never silently
disables enforcement. Application builds should leave this setting unset and
load the deployment file at runtime.

The process uses one validated snapshot until restart. File changes do not take
effect in running processes. Validate updates, replace the deployment file, and
recreate the application with `docker compose up --force-recreate --no-build -d
--wait umami`. Recreation refreshes a file bind mount after an atomic replacement.
Restart every replica for consistent behavior. Configuration is deployment-wide;
there is no dashboard manifest editor or live reload in this stage.

Rollback future enforcement by changing a site to `observe`, removing its
assignment, or removing the overlay/standalone setting and recreating/restarting
the application. Existing records are untouched. Rejected events cannot be
recovered by switching modes unless the sender retries them.

## Observation and rejection

Accepted planned events include `validation: {mode, issues}` in `/api/send`
responses. A valid event has an empty issue list. Observation mismatches retain
HTTP 200 and the original analytics payload. Server warnings include only the
website ID and fixed issue codes, once per website/code per process. They never
include property values, property names, event names, URLs, visitor IDs, or IPs.

Rejection mismatches return HTTP 400 with `error.validation`, before session,
event, event-property, or identity persistence. A same-site signed cache token
does not bypass validation. `/api/batch` applies the policy to every item:
rejections appear in its existing indexed `details` array; observation mismatches
appear in an additional indexed `validations` array. Batches without observation
issues retain their previous response shape. A batch HTTP 200 still requires
checking `processed`, `errors`, and `details`.

Issue codes are `undeclared_event`, `undeclared_property`, `missing_property`,
`invalid_type`, and `too_long`. Responses may include property names to help the
caller fix the request, but never property values. The tracker retains its
existing API behavior; inspect responses in browser network tools or server
warnings for drift. There is no persisted drift dashboard in this stage.

This is a tracking contract, not a personal-data scrubber. Observation mode
stores mismatched properties. Declaring a string does not make its contents
safe. Keep personal data out of custom properties and other collection fields;
use the separate URL and identity privacy policies where appropriate.

## Verification

Unit tests cover malformed/duplicate YAML, reserved keys, file/line diagnostics,
schema types, required and undeclared properties, exact website assignment,
snapshot behavior, startup failures, and bounded warning output. Generated
helpers are compiled against the actual tracker; negative TypeScript cases
check undeclared events, mismatched properties, and missing required data. CLI
tests exercise generation, drift checks, and preservation on failures.

Disposable Docker CI loads the read-only manifest and tests the built tracker,
generated helper, direct collection, cached requests, mixed batches, case-insensitive
IDs, pageviews/performance compatibility, and PostgreSQL read-back. It confirms
observation data is preserved, rejection data is absent, and warnings exclude
synthetic property values/names. A separate invalid manifest must terminate
container startup. These integration overlays must not be used against an
existing deployment.
