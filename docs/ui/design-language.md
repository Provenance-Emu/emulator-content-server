# Web design language

Emulation Server is a compact utility for people finding and organizing their games. Keep the charcoal surfaces, muted text, blue selection, plain labels, and native buttons. Use readable system fonts, modest headings, and left-click/touch actions. Avoid making settings feel like a landing page.

## Global customization

`apps/web/src/app.css` starts with the theme entrypoint. Edit semantic tokens there to change the shared web interface and the desktop interface that imports it:

| Change | Tokens |
| --- | --- |
| Text, backgrounds, borders | `--color-text`, `--color-text-muted`, `--color-canvas`, `--color-surface`, `--color-surface-inset`, `--color-surface-muted`, `--color-border`, `--color-border-strong` |
| Buttons and selection | `--color-control*`, `--color-primary*`, `--color-on-primary`, `--color-selected*`, `--color-accent` |
| Feedback | `--color-danger`, `--color-success` |
| Type | `--font-body`, `--font-mono`, `--text-body`, `--text-label`, `--text-small`, `--leading-body`, `--weight-medium`, `--weight-semibold` |
| Rhythm and panels | `--space-1` through `--space-6`, `--space-8`, `--panel-padding`, `--content-measure` |
| Shape | `--border-width`, `--radius-sm`, `--radius-control`, `--radius-panel`, `--radius-dialog` |
| Controls | `--control-height-touch`, `--control-height-desktop`, `--control-padding-block`, `--control-padding-inline` |
| Focus and motion | `--focus-width`, `--focus-offset`, `--focus-color`, `--motion-control` |

Existing `--ink`, `--ink-dim`, `--paper`, `--panel`, `--line`, `--accent`, and `--warn` are compatibility aliases. Prefer semantic tokens in new components. Apply theme overrides to `:root`; scoped overrides can directly use the compatibility names where old components need them.

Touch controls are at least 2.75rem (44px at the default font size). `.compact-controls` opts a subtree into 2.25rem mouse controls only on wide screens with a fine pointer, hover, and no coarse pointer. Settings and FolderPicker use this class; collection controls retain the same density through their shared selectors. Never shrink coarse-pointer targets to fit a layout. `label.check` gives a checkbox its full labelled hit area.

## Shared pieces

- `components/Tabs.svelte`: horizontal, automatically activated tabs. Supply `tabs`, `selected`, `onchange`, `label`, a page-unique `idPrefix`, and `panelId`. The caller supplies the panel and its `aria-labelledby`. Arrow keys wrap; Home/End select the first/last item; only the selected tab enters the Tab sequence. Storage and `CategoryTabs` use it, preserving their accessible labels and IDs.
- `components/FormField.svelte`: one native input, select, or textarea with a visible label and optional help. The child snippet receives `id` and `aria-describedby`; spread these onto the native control to link its name and description. Keep `required`, `disabled`, `type`, autocomplete, and bindings on that control. Generated IDs are unique per instance; an explicit `id` preserves an existing public association. Help text is a description and does not change the accessible name.
- `components/InlineNotice.svelte`: short text-only feedback. Default `info` is quiet supporting text; `status` announces loading or completion politely; `error` uses an alert. It never moves focus. Keep retry buttons outside the notice and choose announcements deliberately so empty states do not create live-region noise.
- `.settings-form` and `.settings-fields`: forms place actions below a wrapping group of fields. Fieldsets keep their native disabled behavior; controls stay bounded and stretch to fit narrow screens. Labels, help, feedback surfaces, and spacing use the shared tokens.
- `.ui-navigation`: native navigation buttons with transparent resting surfaces and shared `aria-current` selection. Used by Settings and folder Places. Use the right `aria-current` value for the context (`page` or `location`). Component CSS owns orientation and wrapping.
- `.ui-actions`: wrapping action row aligned to the end, with shared spacing. FolderPicker stretches its buttons on phones. Keep main actions in normal document order; use the existing `primary` class sparingly.

Use FormField without replacing native form behavior:

```svelte
<FormField label="Device name" help="Choose a name you’ll recognize.">
  {#snippet children(attributes)}
    <input {...attributes} bind:value={name} required disabled={working} />
  {/snippet}
</FormField>
```

Keep component-specific grids and scroll regions in scoped CSS. Use tokens for their spacing, surfaces, radii, and text. Preserve native disabled behavior, visible keyboard focus, reduced-motion preferences, and existing accessible names.

## Migration and checks

This first pass audited global styles, Settings, Storage, Locations, FolderPicker, and existing tabs. It removes repeated palette declarations, duplicated tab keyboard handlers, local folder-picker control sizing, and redundant Locations overflow styles. FolderPicker and Storage demonstrate semantic tokens; Settings uses shared navigation. Other feature-specific surfaces and bespoke dimensions remain for later small batches. No framework or dependency was added.

`test/browser/design-language.spec.ts` uses ephemeral generated fixtures at desktop and touch-phone sizes. It checks tab navigation, 36px/44px density, bounded overflow, theme propagation, Escape focus return, and absence of writes while browsing. Its screenshots record the representative picker at both sizes. Run the web Svelte check and production build before this focused browser check. Existing folder tests cover registration, failures, and write-target safety.

The second pass applies FormField to Devices and Access, and InlineNotice to Devices, Access, and storage feedback. It keeps all existing form labels, button actions, defaults, validation attributes, and request logic. Helper text now has explicit control associations; long controls shrink within the page. Both components use global classes in `app.css`, so theme and spacing changes reach every instance.

`test/browser/settings-forms.spec.ts` checks accessible names/descriptions, label-click focus, native required validation before requests, disabled controls during a delayed failure, preserved values afterward, conditional fields, Tab order, and viewport overflow on desktop and touch-phone sizes. It captures Devices and Access using generated fixtures without issuing credentials or saving policy changes. Existing Devices and owner Access browser tests cover actual create/revoke and membership/password/policy behavior.
