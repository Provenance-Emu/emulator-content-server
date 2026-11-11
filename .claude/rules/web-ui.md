---
paths:
  - "apps/web/**"
  - "apps/tray/src/**"
---

# Web and tray interface

- Read `docs/ui/design-language.md` first. Use the semantic tokens at the top of `apps/web/src/app.css` (`--color-*`, `--space-*`, `--radius-*`, `--text-*`). No new hard-coded colours, sizes, or fonts in components.
- `apps/tray` imports components and `app.css` from `apps/web`. A token or shared-component change affects both; run `pnpm ui-check` when you touch one.
- The served page has a strict content policy: no inline script, no other origin, no outbound connection. Do not add a CDN font, a remote image, an inline `<script>`, or an analytics call. Anything generated (a QR code, a chart) is rendered locally.
- `apps/web` and `apps/tray` are API clients. They depend on `@ecs/client` only and never open a database or a data directory. A screen that needs new data needs a contract change first.
- Native controls, visible labels, 44px touch targets. `.compact-controls` is the only sanctioned way to get denser mouse controls.
- Copy is plain: games, folders, details, artwork. Hashes, identifiers, and provider names go behind a disclosure.
- Checks: `pnpm --filter @ecs/web check` for routine work. Browser tests only when browser behaviour changed, and they must be headless, muted, and must not open or focus the user's browser. Stop the server and close pages afterwards.
