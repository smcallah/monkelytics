# Monkelytics roadmap

This fork keeps the working Umami application and adds privacy and tracking-plan
features in small stages. PostgreSQL remains the required datastore; new stages
should not require extra infrastructure.

## Existing foundation

- Cookieless browser tracking, multiple websites, realtime, custom events,
  first-party tracker hosting, and dark mode come from Umami.
- Verification scripts and CI cover tests, types, lint, application build,
  Docker build, and disposable runtime checks.
- `/health` provides application liveness and a Home Assistant integration
  example. It does not establish database readiness.
- Deployment lifecycle and IPv4/IPv6 support preserve persistent database data.
- Tracker cache tokens are scoped to the requested website.
- Opt-in daily visitor rotation uses midnight UTC.
- Opt-in URL query privacy filters the tracker and server collection path.
- An optional local demo supplies real pageviews and a sample custom event.

## Completed stage: anonymous collection policy

Merged: [anonymous collection](anonymous-collection.md).
Standard collection remains the default. The opt-in policy rejects identification,
ignores explicit event IDs, uses receive time, and separates anonymous visitor IDs
from previously identified sessions. Browser configuration suppresses explicit
identification and strips ID/timestamp overrides before transmission.

Acceptance requires unit and tracker tests, timezone checks, typecheck, lint,
build, and disposable browser/PostgreSQL validation. Deployment is a separate
step after reviewing the change and choosing whether to enable the policy.

## Current stage: declared tracking plans

Implemented in this branch: [tracking plans](tracking-plans.md). An optional
deployment-managed `analytics.yaml` assigns event/property schemas by existing
website UUID. The CLI validates manifests, generates typed helpers for the
existing tracker, and checks for stale generated output. Server validation
defaults to observation; rejection is an explicit per-site choice. Startup
validates the file, and processes keep a snapshot until restart.

Acceptance covers format and source diagnostics, generated helper types/runtime,
website isolation, same-site caches, direct and batch APIs, unchanged collection
without manifests, startup failures, full tests/types/lint/build, and disposable
browser/PostgreSQL read-back. No schema migration or new service is required.

Ordinary Umami dynamic events remain available on unassigned sites. Operators
assign and update plans through their existing deployment configuration; existing
website ownership and permissions remain intact. Deployment and choosing to
enable a plan are separate steps after reviewing this change.

## Next stage: tracking-plan operations and visibility

- Use observation on an approved real site and review schema drift before
  choosing rejection. Update that site's plan and generated helper together.
- Evaluate a permission-checked dashboard view for active plans and drift. Keep
  diagnostic data free of visitor/property values; explain any required database
  changes before implementation.
- Extend version 1 only for demonstrated needs such as enums or nested schemas,
  with explicit storage, compatibility, and generated-type semantics.

## Later decisions

- Review payload client overrides, proxy trust, and the remaining collection
  surfaces before making broader anonymous-mode guarantees.
- Define cache-token expiry and website revalidation separately.
- Consider changing privacy defaults only after documenting compatibility,
  import behavior, reporting semantics, and a rollback procedure.
- Revisit branding and dashboard additions as their own scoped changes.
