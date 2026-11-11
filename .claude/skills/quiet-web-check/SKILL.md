---
name: quiet-web-check
description: Use when verifying a change to the emulator content server's web interface (apps/web) or tray, including when a browser check seems necessary.
---

# Checking web changes without disturbing the user

Pick the smallest check that covers what changed.

| Changed | Run |
| --- | --- |
| Logic in `apps/web/src/lib/*.ts` | `pnpm --filter @ecs/web test` |
| A component, markup, or types | `pnpm --filter @ecs/web check` |
| Tokens in `app.css` or a shared component | `pnpm ui-check` (web and tray) |
| Needs the bundle | `pnpm ui` |
| Layout or behaviour only a browser shows | one headless Playwright run, below |

Browser rules, always:

- Headless and muted. Never headed, never the user's own browser, never a window that takes focus. If headless graphics fail, report that; do not fall back to a visible browser.
- Game audio off before launching anything that plays.
- Use a throwaway data directory in the scratchpad, not `content-data/`.
- Afterwards, stop the server you started and close every page. Leave no emulator or audio loop running.

```sh
pnpm build && pnpm ui && pnpm --filter @ecs/web test:browser -- <spec>
```

If a check cannot meet these rules, say what could not be verified instead of running it.
