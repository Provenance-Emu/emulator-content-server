# Player windows and AirPlay feasibility — 2026-10-31

This is source research for the next batch, not an implemented feature or an approved design. Browser tests must remain headless and silent without changing foreground app/tab focus. No browser or emulator was launched for this research.

## Current player

`Player.svelte` owns startup, save synchronization, input, skin selection and the page lifetime. It starts one runtime after the Start gesture. The opaque-origin sandbox iframe is created by `sandbox.ts` and communicates over a private MessagePort; it cannot access app credentials. The pagehide teardown event currently releases the runtime; a normal visibility change is a separate lifecycle event. Display controls provide fit/stretch, aspect ratio, filtering, height and optional fullscreen. The parent canvas is a placeholder once the iframe is running, not an accessible live video source.

A separate `/play/` document can own the same player UI and its own single runtime from startup. Launch needs to retain selected profile, source/item, save target, selected battery/state and explicit save-format confirmation, without putting credentials in URLs. Popup blocking and iPhone's new-tab behavior need ordinary-page fallbacks. Moving the live iframe into another document must not be assumed to preserve the running emulator. A screenshot loop would neither provide synchronized live audio nor prove a native video-stream transport.

The `/play/` host already has COOP `same-origin`, COEP `require-corp`, and a restrictive host CSP. The guest stays sandboxed with scripts only. A launch/control channel must account for opener isolation and document lifecycle; it must not weaken these policies or start a duplicate core to imitate detaching a game.

## AirPlay evidence

- [Apple's custom Safari AirPlay control](https://developer.apple.com/documentation/webkitjs/adding_an_airplay_button_to_your_safari_media_controls) targets audio/video media elements. Merely detecting `webkitShowPlaybackTargetPicker` is not proof that our emulator output can reach a receiver.
- [WebKit: MSE with AirPlay](https://webkit.org/blog/15036/how-to-use-media-source-extensions-with-airplay/) explains that AirPlay needs a receiver-playable URL. Its documented solution supplies a separate MP4/HLS-style source alongside a browser-local MediaSource. A browser-local blob URL does not serve that role.
- [WebKit issue 281693](https://bugs.webkit.org/show_bug.cgi?id=281693), checked today, is still NEW and reports failure for a video element whose `srcObject` is a MediaStream. The report names Safari 18; this is evidence of an unresolved report, not hardware acceptance of every newer Safari release.
- [Apple's Mac mirroring guide](https://support.apple.com/guide/mac-help/stream-content-to-apple-tv-mh40624/mac) describes Control Center Screen Mirroring and window/screen sharing. [Apple's iPhone AirPlay guide](https://support.apple.com/guide/iphone/stream-video-and-audio-from-your-iphone-iphd668e80e6/ios) covers screen mirroring and nearby receivers.

The supported initial path is OS Screen Mirroring with an uncluttered game display. A direct in-page game AirPlay path requires separate output/audio capture, a receiver-compatible transport and actual Apple receiver testing. The browser cannot silently invoke system screen mirroring. A game-view mode may make mirroring useful, but must be labeled as such rather than claiming a direct AirPlay connection.

## Proposed scope

After an interrupted scope question, the user requested continuation. The [design draft](../superpowers/specs/2026-10-31-browser-player-windows-design.md) proposes the recommended separate-window startup path and OS Screen Mirroring. This remains an explicit assumption for design approval; seamless live detachment and direct receiver transport are not claimed. No product implementation has started.
