# Browser player core options and GLSL presets

Status: approved by the user on 2026-10-29; implementation complete and locally verified. The preceding capture/gallery/display batch is committed as `adbdcb1`.

## Intent and approach

Keep our Svelte UI, authenticated client and opaque Emscripten sandbox. Add usable core settings and shader controls, prioritizing Safari on Mac and iPhone. The user selected keeping our frontend and reusing useful Nostalgist patterns; this proposal applies that decision to the next batch.

Use runtime-discovered core options and the installed RetroArch GLSL renderer. This is the sensible continuation of the verified runtime path. Startup-only configuration cannot provide live controls; replacing the renderer with a WebGPU compositor would add a second rendering pipeline and would not expose core options. Whole-wrapper adoption was already evaluated and rejected for this frontend. Nostalgist's core-options file generation and shader filesystem staging remain references; do not copy its loader rewriting or CDN resolution.

The defaults below are implementation proposals, not additional requirements attributed to the user.

## Evidence and limits

The external pinned FCEUmm pair was probed on 2026-10-29 with the original generated acceptance program. Desktop WebKit and iPhone-profile WebKit both returned 44 option keys, current values and descriptions via `GET_CORE_OPTION`. Keyed queries returned accepted values. Switching `fceumm_palette` from `default` to `rgb` changed the rendered center pixel from `[60,190,255,255]` to `[109,182,255,255]` in both engines; restoring `default` restored the original pixel. This establishes a visible live-option change for this build, not just a successful no-op acknowledgement. Product acceptance must repeat this through our UI and shared command owner.

The prior [Nostalgist comparison](../../operations/browser-player-nostalgist-comparison-2026-10-28.md) and capture diagnostic verified GLSL output on the same pair. Neither successful exports nor the browser name proves that every installed core supports these operations. Playwright WebKit/device emulation is not physical Safari/iPhone acceptance.

## Core options

- Add a collapsible, searchable Core options section using native accessible selects. Show each reported description and current value; fetch allowed values on demand with a bounded cache. Refresh after changes so dependent controls do not retain stale current values. Do not invent categories, default values, hidden-state metadata or restart flags absent from this ABI.
- Preserve restart wording supplied in core descriptions. Also explain that some changes need a fresh launch; never restart automatically or risk unsaved progress. A user can save/export through existing controls before leaving. No new destructive restart button in this batch.
- Use one command/reply owner shared with save/load. Extend `CommandChannel` with bounded typed queries and setters, distinct success grammars and existing quarantine-on-ambiguity behavior. Never introduce a second reply poller. Keep old save acknowledgements unchanged.
- Probe support only when the runtime exports the command helpers. Explicit unsupported replies disable options while preserving playback; malformed, oversized, ambiguous or timed-out replies quarantine the channel and explain which save/settings operations require reload. A capability probe must not silently consume a later save acknowledgement.
- Validate keys, values, reply structure, duplicates and finite counts/lengths in host and guest. Support spaces in legitimate values (for example RAM fill values); reject controls/newlines and command injection. The guest only permits the specific core-option command forms, never arbitrary commands.
- Existing `saveCompletion: none` means no synchronized saves, not necessarily no settings. Core settings may be enabled for such a build only when the required helpers and actual option-query behavior are verified. Non-RetroArch profiles remain playable with settings unavailable.

## Remembering preferences

- Session-only changes are the default. Offer explicit Remember for this core and Remember for this game actions plus Clear remembered settings. Core settings apply first; a game override wins per key. Display the active scope. Game scope requires an item or stable source ID.
- Preferences are local to this browser and server origin, keyed by profile ID and the complete loader/WASM hashes. They are shared browser preferences, not account-synchronized settings. Store no credentials, content, saves or screenshots. Do not derive storage keys from bearer tokens. An updated core pair does not inherit overrides automatically.
- Bound stored JSON and tolerate unavailable/private storage without breaking play. Treat storage as untrusted. Remember only settings the runtime actually accepted; do not persist failed writes. Clear remembered settings removes future overrides and explains that already-running options remain until changed or a fresh launch.
- At the next launch stage a bounded core-options file at a fixed `/ecs` path and configure `core_options_path`, following Nostalgist's file-generation pattern. Strictly validate and encode config entries; no raw config editor. Re-query after launch and flag saved values that the build did not accept. Do not claim that a file write changed the running core.
- Reported defaults are absent from the current text ABI. Do not label the initial current values as factory defaults. Clearing stored overrides and starting fresh uses the core's own defaults; no misleading live Reset to defaults action.

## Shader controls

- Start with Off, lightweight Scanlines and LCD grid presets implemented as original, small single-pass GLSL shaders. Off is the default, especially on phones. No third-party shader pack or CDN dependency. Keep future curated upstream presets possible with pinned sources and license attribution.
- Stage trusted, bundled preset/source bytes at fixed `/ecs/shaders` paths, then use a narrow shader-select RPC accepting only built-in IDs. Feature-detect the required native shader/string/allocation exports; keep paths, pointers and generic native invocation private to the guest. Free allocations in `finally`. Disable controls for unsupported builds without blocking play.
- Explicitly distinguish selecting/requesting a preset from successful rendering. A native boolean alone may precede deferred compilation. Use the supported completion mechanism if the installed ABI supplies it; otherwise report accepted selection with bounded post-frame/error checks and retain an honest failure state. Do not claim a compiler-complete acknowledgement that the ABI cannot provide.
- Off must actually disable the effect, not just change the dropdown. If applying a preset fails, restore Off where possible and show the failure; if recovery also fails, keep the state unknown and require reload. Never silently retain a failed preset as the applied selection or remember it as successful.
- Shader operations share the player action lock with capture/load/settings. Direct shader calls must not generate or drain anonymous save replies. Refocus the actual iframe/canvas when fresh frames are needed, preserving the Safari capture fixes.
- Optional remember actions use the same per-core/per-game local scopes, storing only built-in preset IDs. Ordinary CSS smooth/sharp filtering remains a separate display control; explain its relation to shader output where necessary.
- Screenshot capture should show the visible shader output. Native state thumbnails may show raw game output; label this distinction. Verify that applying, switching and disabling shaders does not break screenshot capture, resize/aspect behavior or state save/load.
- Custom shader upload/editing, multipass packs, shader parameters, Slang, glslang and WebGPU are follow-ups. They are not exposed as working toggles in this batch.

## Boundaries and validation

Changes stay in `apps/web` and related documentation. Keep `sandbox="allow-scripts"`, current CSP, host credentials, upload retry/idempotency/conflict behavior and API contracts. No database/schema/protocol changes or new package dependency. This batch's commit request covers the preceding completed batch only; do not push or commit the new implementation without further authorization.

Before implementation, settle finite message/count/storage limits from the actual reply shape. Add focused failing regressions for malformed/oversized option data, invalid values and command injection, unsupported queries, shared settings/save ordering, preference isolation/corruption and failure recovery. Add browser checks of actual UI interaction, shader on/switch/off pixel changes, meaningful core-option pixel changes, captures with shaders and a save/load round-trip using the original generated program. Prioritize desktop WebKit and iPhone-profile WebKit, plus Chromium; run affected web tests, Svelte checks and build. No full core/native/OS matrix.

One focused review covers the expanded command bridge and settings/save ordering. Physical Safari/iPhone and sustained phone performance remain explicit acceptance gaps unless available for direct testing. The builder may choose component names, exact limits, styling consistent with the player and lightweight shader math; do not broaden the public API or substitute fabricated metadata.

The read-only builder check found no consequential unanswered design questions. The user approved implementation on 2026-10-29.

## References

- [Nostalgist launch/core configuration](https://nostalgist.js.org/apis/launch/)
- [RetroArch shader pipeline](https://docs.libretro.com/guides/shaders/)
- [RetroArch core override behavior](https://docs.libretro.com/guides/overrides/)
- Local installed frontend source and runtime were inspected, rather than assuming latest upstream commands are present in every artifact.
