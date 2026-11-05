# Dolphin worker filesystem

Dolphin's reviewed JavaScript/WASM pair runs in a dedicated module worker named
`ecs-dolphin-core`. The name intentionally differs from the core's `em-pthread`
workers: this worker owns the main Emscripten runtime and filesystem. The iframe
keeps only the canvas compositor, input adapter and AudioContext. It receives no
raw WASM memory. The approved loader and WASM hashes are unchanged and checked
again inside the core worker. No core resources, user files or credentials are
fetched by the companion; its existing blob-only network policy remains intact.

The first-party `dolphinWorkerSource()` function serializes the worker host through
the existing private initialization port. `init` transfers the bounded loader and
WASM buffers to that worker. Existing `mkdir`, small `write`, and `main` requests
retain their protocol. MEMFS staging is limited to 64 MiB; larger Dolphin files
must use `mount` with `{ path: '/ecs/content/game.EXT', file: File }`. The mount
accepts only supported normalized game paths and one nonempty Blob/File within
the selected profile's limit, at most 9 GiB. It does not use a File's original
name or call whole-file `arrayBuffer()`.

The main worker mounts the exported `WORKERFS` at `/ecs/content`, using its
`blobs` option and an explicit safe basename. Emscripten binds FileReaderSync in
that worker and reads Blob slices for native filesystem requests. Pthread FS
requests proxy to the main core worker, where synchronous file reads are allowed.
WORKERFS is read-only: original or staged file bytes are not modified by the core.
The app streams files above 32 MiB to private browser disk before passing a File;
there is no disc-sized MEMFS fallback when disk storage is unavailable.

The iframe permits one display tick in flight. Each tick carries a bounded
controller state and audio demand. Replies contain aggregate native JIT/video
status, an owned RGBA frame of at most 2048×2048, and at most 1024 stereo PCM16
frames. Owned ArrayBuffers are transferred rather than sharing WASM views. Audio
is requested only while the iframe AudioContext can consume it. A blocked or slow
native call therefore does not block the app's UI thread or build an unbounded
render queue.

Explicit screenshots use a separate worker capture request. A running core is
paused while its real positive-XFB frame is copied and resumed in `finally`;
a core that was already paused stays paused. Normal frame presentation does not
pause emulation. PNG encoding stays in the iframe, with an 8 MiB result limit.

An explicit stop attempts native core stop, pthread termination, filesystem
unmount and object-URL revocation. Page hide, iframe unload, worker failure and
RPC timeout hard-terminate the core worker; descendant dedicated workers share
its lifetime. Hard termination is the final boundary when graceful native stop
cannot run. The parent releases its private disk staging entry after disposing
the runtime. A browser crash can leave a staging file in private origin storage;
clearing that site's storage reclaims it, without touching the original user
file.

Focused generated-fixture tests cover a sparse 8 GiB Blob without eager reads,
bounded FileReaderSync slices above 4 GiB, unsafe mount rejection, small DOL
staging, transferable frame/audio bounds, pause/resume capture, and worker
cleanup. Real headless acceptance separately exercised GameCube/Wii original
programs and a generated 1,459,978,240-byte GameCube ISO through authenticated
source download, OPFS staging and WORKERFS. That does not establish general
commercial-title or Wii Remote compatibility.
