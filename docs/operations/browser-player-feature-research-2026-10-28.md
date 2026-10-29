# Browser player feature research — 2026-10-28

Research and proposed sequencing for the embedded Emscripten player. This is not an approved implementation design. No runtime or browser-device acceptance testing was performed for this research.

Follow-up: the authorized [one-core Nostalgist comparison](browser-player-nostalgist-comparison-2026-10-28.md) records actual runtime and unchanged-UI experiments. Target users are primarily on Mac/iPhone, especially Safari; experimental features may be opt-in for advanced users, with supported defaults and actual capability checks.

## Requested experience

- Shader presets and parameters; evaluate GLSL, Slang and WebGPU paths.
- Discoverable core options, with useful descriptions and persistent overrides.
- BIOS/firmware selection and readiness checks.
- Battery saves, screenshots, and save-state browsing/loading with thumbnails.
- Controller, keyboard and mouse mapping diagrams, an editor, and overlays or underlays; touch controls.
- Web controllers, MIDI devices, camera, microphone, gyro and other sensors.
- Resizing, scaling, breakout windows, popout, and AirPlay.

## Existing implementation

The Svelte player lives in `apps/web/src/player`. `Player.svelte` selects profiles, content and saves before startup. `controller.ts` stages content, selected saves and profile assets into MEMFS and writes a fixed RetroArch configuration. The actual canvas is inside `apps/web/public/play/sandbox.html`, in an opaque-origin iframe created by `sandbox.ts` with `sandbox="allow-scripts"`. The host retains authenticated API access; a private MessagePort provides bounded runtime operations.

The bridge currently exposes filesystem operations, startup, focus, and just three save commands. `commands.ts` serializes command/reply operations because that ABI has no request IDs. `saves.ts` waits for successful command completion before reading bytes, retains failed upload requests for retry/export, and preserves the gameplay revision baseline for conflict handling. State loading only reloads the state selected before Start. Captures use one logical slot-0 path; this is not a state gallery. There is no player screenshot operation or state-thumbnail association.

Most catalogued official web cores explicitly have `saveCompletion: none`; see [the existing inventory](libretro-web-core-inventory-2026-10-28.md). The factory checks established loader startup and filesystem wiring, not gameplay, save support, peripherals or graphics. Do not infer feature support from successful installation or core family alone.

The outer display currently uses a fixed 4:3 CSS aspect ratio and a 70vh height cap. The sandbox canvas stretches to its container with `object-fit: contain`. There is no user-facing scale, fullscreen, popout or mapping UI. The iframe permits gamepad/autoplay/fullscreen but has no device bridge or pointer-lock sandbox allowance. Existing extra-asset staging is not a general BIOS manager; it includes a special Atomiswave BIOS path for the Dreamcast profile.

## Existing projects worth evaluating

| Project | What it provides | Fit and open work |
| --- | --- | --- |
| [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS) | Full RetroArch web frontend; settings, keyboard/gamepad/touch controls, shaders, save states and screenshots. Its current `GameManager.js` wraps structured core-option exports. | Strongest complete UI reference. It uses its own runtime exports, asset loading and persistence assumptions; adoption needs an adapter evaluation against our sandbox, authenticated loading and server saves. Repository declares GPL-3.0. |
| [Nostalgist](https://github.com/arianrhodsandlot/nostalgist) | Smaller RetroArch wrapper with BIOS, configuration, GLSL shaders, resizing, input methods, screenshots, SRAM and state APIs. `saveState()` returns state and optional thumbnail blobs. | Promising wrapper or reference for our existing Svelte UI. Does not supply the complete settings/mapping/gallery product. Default asset resolution uses external sources, so our verified byte-loading path would need integration. Repository declares MIT; that does not describe every core's license. |
| [RetroArch Emscripten](https://github.com/libretro/RetroArch/blob/master/Makefile.emscripten) | The existing underlying frontend. Current upstream enables GLSL, screenshots, overlays and shader pipeline; exports include shader, screenshot, pause, reset and volume commands. | First inspect each installed artifact's exports and verify completion behavior. Current upstream source is evidence of possible adapters, not proof that any pinned artifact exports or implements them. |

Sources inspected: [EmulatorJS options](https://emulatorjs.org/docs/options/), [GameManager source](https://github.com/EmulatorJS/EmulatorJS/blob/main/data/src/GameManager.js), [Nostalgist launch options](https://nostalgist.js.org/apis/launch/), [state and thumbnail API](https://nostalgist.js.org/apis/save-state/). Upstream default branches and documentation are mutable; an implementation must pin the revisions it adopts.

## Rendering, scaling and windows

**Recommended starting point:** keep the current Svelte player and isolated runtime, and extend a typed capability bridge. The other viable approaches are adopting EmulatorJS behind an adapter, or evaluating Nostalgist inside the isolated runtime. Choose the approach before treating this note as an implementation plan.

Display controls should include core-reported aspect ratio, fit, fill/stretch as an explicit choice, integer scale, fixed 1x/2x/3x sizes, nearest/linear filtering, fullscreen and a resizable player window. Integer scaling needs the actual core geometry and a policy for viewports smaller than the native image. High-DPI backing resolution and shader output size are separate from logical game resolution; CSS resizing alone does not implement these correctly.

Breakout controls/state browsers can be ordinary same-origin windows connected to one session owner. A new game window launched before startup is simpler than detaching an active canvas. Do not start a second emulator to simulate live popout. Moving the sandbox iframe between documents can affect its lifecycle and must be tested before promising seamless detach/reattach. Window closure, input focus, audio ownership and pending-save recovery belong in that acceptance test.

[Document Picture-in-Picture](https://developer.chrome.com/docs/web-platform/document-picture-in-picture) supports arbitrary HTML in an always-on-top window where available. Feature-detect it and retain an ordinary window fallback. [Window Management](https://developer.mozilla.org/en-US/docs/Web/API/Window_Management_API) can add monitor selection where supported, but manual dragging should remain sufficient.

[Remote Playback](https://developer.mozilla.org/en-US/docs/Web/API/Remote_Playback_API) controls audio/video media elements, not an emulator canvas. [Canvas capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream) can supply a video track for a separate preview/recording experiment, but does not establish AirPlay transport, audio synchronization or acceptable game latency. Treat AirPlay as a separate feasibility experiment with actual Apple hardware. OS screen mirroring is the initial user path; do not advertise a working in-page AirPlay button from API detection alone.

## Shaders and core options

Start with tested GLSL/WebGL presets such as CRT, scanlines, LCD and a simple smoothing filter. Bundle verified preset dependencies, expose bounded parameters and retain a fast off switch. Distinguish presentation filtering from core internal-resolution settings. A preset being loadable does not establish acceptable performance on mobile devices.

GLSL, glslang, RetroArch Slang and WGSL are different things. glslang is a compiler component, not a browser graphics backend. [RetroArch Slang](https://docs.libretro.com/development/shader/slang-shaders/) describes a shader/preset pipeline; [WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) uses WGSL and requires an actual WebGPU rendering path. Safari added WebGPU in 26.0 according to [WebKit](https://webkit.org/blog/17640/webkit-features-for-safari-26-2/). Browser support alone does not make a RetroArch web build support Slang or WebGPU. Evaluate those after the existing GLSL route works.

For core options, expose runtime metadata where the build supports it: keys, labels, descriptions, categories, allowed values, defaults and visibility. EmulatorJS's current structured export is useful prior art, but is not an export contract for our existing builds. Preserve older core-option interface support as needed. Offer per-core defaults and per-game overrides, reset actions and restart-required feedback. Initial config-file support and live option updates are separate capabilities.

## Saves, screenshots and firmware

The state browser should show thumbnail, label, timestamp, core/build identity, slot or bookmark, and conflict status, with load, rename, export and delete actions. Support browsing during play, quick save/load, named bookmarks and optionally autosave/resume after a manual path is reliable. Distinguish battery saves from emulator states; do not infer state compatibility from an extension or system name.

Capture the state and its preview as one logical operation. Prefer a runtime-produced thumbnail associated with the completed state; an unrelated later canvas screenshot can depict a different frame. Support missing thumbnails and partial preview-upload recovery without losing the state. Keep retries idempotent and preserve existing keep-both conflict behavior. Decide the authenticated asset association and core/build metadata before implementing a gallery; do not assume an unlinked artwork upload is enough.

Standalone screenshots should support download and, if selected, library storage. Capturing raw game pixels versus shader/bezel output should be an explicit choice when the runtime can provide both.

Firmware readiness needs required/optional firmware metadata, expected filename/subdirectory and size/checksum where available, user-provided file selection, validation, and bounded staging. Show missing or invalid requirements before launch. General firmware management is broader than the existing profile-resource list; server persistence and permissions need explicit design. Never package firmware in the repository.

## Browser devices and libretro interfaces

| Feature | Browser path | Integration requirements |
| --- | --- | --- |
| Standard controllers | [Gamepad API](https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API) | Device and port assignment, button/axis remaps, dead zones, hot-plug, disconnect handling; probe rumble separately. The iframe currently permits gamepads, but there is no mapping UI. |
| Keyboard/mouse/touch | Keyboard and pointer events; [Pointer Lock](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_Lock_API) | Mapping diagrams with live highlights, press-to-bind, restore defaults, analog sensitivity and overlay editor. Pointer lock needs an explicit sandbox/policy change and escape behavior. |
| MIDI | [Web MIDI](https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API) | Input/output port selection, timestamped bounded queues and a libretro MIDI adapter. Limited availability; require a secure context and user permission. Keep MIDI-as-controller bindings separate from emulated-machine MIDI I/O. |
| Unusual controllers and controller IMUs | [WebHID](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API) | Optional device-specific drivers where supported. Generic gamepad access does not expose arbitrary controller gyro data. Do not require HID for ordinary controllers. |
| Camera | [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) | Host-owned permission and selected camera, format conversion and libretro camera callback bridge. A sandbox without `allow-same-origin` cannot request this directly. |
| Microphone | getUserMedia plus audio processing | Host-owned permission, selected device, sample-rate conversion and bounded PCM buffering into libretro microphone callbacks. Existing runtime validation rejects workers/worklets; an AudioWorklet solution needs a separately evaluated profile/policy change. |
| Phone/tablet motion | [DeviceMotion](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicemotion_event), orientation events; [Sensor APIs](https://developer.mozilla.org/en-US/docs/Web/API/Sensor_APIs) where available | Browser-specific permission flow, calibration, axis/orientation normalization and libretro sensor adapter. Device motion and a physical controller's IMU are separate inputs. |
| Keep display awake | [Screen Wake Lock](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Wake_Lock_API) | Feature detection, visible-session lifecycle and reacquisition after visibility changes. |

[libretro.h](https://github.com/libretro/RetroArch/blob/master/libretro-common/include/libretro.h) defines camera, MIDI, microphone and sensor interfaces. Their presence in the header does not make them implemented in a frontend or requested by a core. Useful UI must reflect browser support, secure-context availability, permission state, runtime adapter support and the selected core's actual needs. Test those layers independently.

The server supports ordinary LAN HTTP; APIs requiring secure contexts need an explanation and an HTTPS path. Localhost exceptions do not make an arbitrary LAN IP secure. Permissions should be requested by the trusted host in response to a user action, with device streams stopped when the session ends. Keep credentials and generic device handles out of the core sandbox; pass only validated data through narrowly defined operations.

## Proposed order, pending direction

1. Define and probe runtime capabilities. Improve the player shell: resizing, aspect/scale/filter controls, fullscreen, launch in a separate window, focus and audio controls. Validate which display features require bridge changes versus CSS.
2. Add verified screenshot/state operations and firmware staging; implement thumbnail state browsing and in-session loading while preserving retry/conflict behavior. Start with a known compatible core build before expanding profiles.
3. Add core-option metadata and overrides, tested GLSL presets, controller/keyboard/mouse remapping and overlay/underlay editing. Share the settings model with breakout panels.
4. Add MIDI, mic, camera, motion and optional HID adapters individually, with a core that exercises each adapter. Run separate feasibility experiments for seamless live popout, WebGPU/Slang, and AirPlay.

Validate affected web behavior with focused unit tests, Svelte checking/build, and browser checks for the canvas, sandbox, windows and device boundary changes. Use synthetic fixtures and lawful generated game data. Do not run a full core/OS/native matrix for UI iteration.
