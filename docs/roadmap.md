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

## Current stage: anonymous collection policy

Implemented in this branch: [anonymous collection](anonymous-collection.md).
Standard collection remains the default. The opt-in policy rejects identification,
ignores explicit event IDs, uses receive time, and separates anonymous visitor IDs
from previously identified sessions. Browser configuration suppresses explicit
identification and strips ID/timestamp overrides before transmission.

Acceptance requires unit and tracker tests, timezone checks, typecheck, lint,
build, and disposable browser/PostgreSQL validation. Deployment is a separate
step after reviewing the change and choosing whether to enable the policy.

## Next stage: declared tracking plans

1. Inspect current tracker types, event payload validation, persistence, and
   website ownership before choosing a manifest shape.
2. Add a small `analytics.yaml` format with declared event names and property
   types, plus a CLI validator with clear file/line diagnostics.
3. Generate typed event helpers that call the existing tracker API.
4. Add opt-in server validation scoped to each website. Start with observable
   reporting of undeclared events/properties; make rejection an explicit choice.
5. Test valid/invalid manifests, generated helpers, website isolation, event
   schemas, and unchanged behavior for websites without a manifest.

Keep ordinary Umami dynamic events working. Decide how manifests are assigned
and updated before implementing enforcement. This stage must not silently drop
existing traffic or store raw IP addresses.

## Later decisions

- Review payload client overrides, proxy trust, and the remaining collection
  surfaces before making broader anonymous-mode guarantees.
- Define cache-token expiry and website revalidation separately.
- Consider changing privacy defaults only after documenting compatibility,
  import behavior, reporting semantics, and a rollback procedure.
- Revisit branding and dashboard additions as their own scoped changes.
