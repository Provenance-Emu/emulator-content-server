# Loading large and compressed discs in the browser

Status: step 1 built (chunk-backed delivery for Flycast CHD and CDI, 2026-11-22), not yet accepted with a real disc; the rest proposed. Date: 2026-11-22.

## The problem

A game is copied whole into the browser's memory before an emulator starts, with a 512 MiB ceiling (9 GiB for GameCube and Wii, which are staged to the browser's private file storage first). Most Dreamcast GD-ROM images are over 1 GB, so they are refused. Compressed images are either passed through because the emulator happens to read them, expanded whole in the browser, or refused.

The owner's libraries are full of compressed discs: CHD, RVZ, CISO, and ZIP or 7z around a disc. The server should not have to expand them, the home network should not have to carry the expanded bytes, and a game should start before all of it has arrived.

## What iCube already proved

The Dolphin fork inside iCube streams RVZ and CISO over plain HTTP ranges from a WebDAV folder. Those formats are an index plus independently compressed blocks, so the reader fetches the index, works out which compressed blocks hold the disc sectors it wants, fetches only those, and keeps them. Identifying a game for the library needs only the blocks that hold its header, not the disc. The server on the other end only has to answer range requests.

This design is that idea, made the way every emulator here gets its bytes.

## Four layers

Each layer has one job and knows nothing about the one above it.

1. **Bytes from the server.** `GET` with `Range` on the content routes that exist today. No new endpoint is needed for a file the server already has. One addition, later: a ZIP or 7z that wraps a disc is not seekable, so the server expands it once into its staging area (the CHD converter already stages this way) and serves ranges of the result.
2. **Blocks kept in the browser.** Fixed-size blocks in private file storage, keyed by the file's SHA-256 and block number, with a small map of which blocks are present. A block is fetched once per device. Storage is released oldest first, as the disc cache does now. Where private file storage is missing (`storage.files` in `lib/browser-features.ts`), blocks are kept in memory for the session.
3. **A reader for the container.** Turns "sector N of the disc" into "these byte ranges of the file". Three cases:
   - The emulator reads the container itself (Flycast reads CHD; Dolphin reads RVZ, CISO, WIA and GCZ). Then this layer does nothing and the emulator is handed the compressed file. This is the cheapest path and the default.
   - The emulator cannot, and the container is block-indexed. A small reader compiled to WebAssembly does the translation: libchdr for CHD, a CISO/CSO reader, Dolphin's blob readers for RVZ and WIA.
   - The container is not seekable. Layer 1's expanded copy is used.
4. **Handing bytes to the emulator.** Chosen per emulator and per browser:
   - **Chunk-backed file** (any browser, any emulator built like today's): the file in the emulator's file system is a list of separate chunks instead of one buffer. Every block must be present before the emulator starts. No rebuild of the emulator.
   - **File in private storage, mounted** (what GameCube and Wii do now): download to storage, then mount. Needs the emulator in a worker.
   - **On demand** (the iCube behaviour): the emulator asks for a block that is not there yet and waits for it. Waiting needs the emulator in a worker with shared memory, or an emulator built with stack switching (`wasm.threads` or `wasm.stackSwitching`). The game starts as soon as its first blocks arrive.

## Choosing

The choice is made from what is true, in this order, and never from the browser's name:

1. What the emulator's profile says it can read and how it is built (a new optional `delivery` list in the profile: `chunks`, `mounted`, `on-demand`; and the containers it reads itself).
2. What the browser has (`lib/browser-features.ts`).
3. The size of the game against what memory can hold, when the only delivery left is chunks.

Network speed decides one thing only, and only in on-demand mode: whether to start at once or fetch ahead first. It is left out of the first version.

## The same reader on the server

The container readers from layer 3, compiled to WebAssembly, also run in the server's scan. Identifying an RVZ, CISO or CHD then means reading its index and the few blocks that hold the disc header, exactly as iCube's import does, instead of expanding the disc or guessing from the file name. One reader, tested once, used on both sides.

## What a play session teaches

Which blocks a game reads while it boots is the same every time. The player records the block numbers read in the first minute and sends them to the server against the file's SHA-256 (numbers only, no content). The next device to play that game fetches those blocks first. In chunk-backed mode this does not shorten the wait, since everything is needed; in on-demand mode it removes most of the pauses.

## The spike

Question: can an emulator built the way Flycast is here (Emscripten, in-memory file system, no threads, main thread) read a file much larger than 512 MiB that is not one buffer?

What was done: a small C program that does what a disc reader does (`stat`, then seek far and read a few bytes) was built with Emscripten 6.0.13 using those same settings. Its file was a 1.5 GiB file whose contents live in separate 4 MiB chunks, attached by replacing the file node's read operation. Source and runner: `scripts/browser-core/spikes/chunked-file/`.

```sh
cd scripts/browser-core/spikes/chunked-file
emcc spike.c -O1 -sMODULARIZE -sEXPORT_ES6 -sFORCE_FILESYSTEM \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAP8 -sINVOKE_RUN=0 -sENVIRONMENT=node,web -o spike.mjs
node run.mjs
```

Result: the program saw the right size, and reads at 0, across a chunk boundary, at 600 MiB, past 1 GiB and at the ragged end all returned the right bytes. Six probes touched five chunks. The emulator's own memory stayed at 16 MiB, because the file is never copied into it.

What this settles: the chunk-backed file works with the file system Flycast is built with, without rebuilding Flycast, and the 512 MiB ceiling is a policy of this player, not a limit of the mechanism.

What it does not settle:

- It ran in Node, not in a browser frame, and with chunks made on demand rather than a gigabyte of real data held in memory. How much a phone or a tablet can hold is unknown.
- It was not Flycast. From the build recipe (`scripts/browser-core/`): Flycast carries its own CHD decoder, is built with the in-memory file system, no threads, no stack switching, and declares `chd`, `cdi`, `cue`, `elf`, `gdi`, `zip`. In a local checkout of upstream Flycast (not the commit the recipe pins), the CHD reader opens the file as an ordinary stream and libchdr reads it with seek and read, with no memory mapping, which is what the chunk-backed file serves. That has not been run against a real disc.
- No Dreamcast game was started. That needs a built Flycast package and a disc the owner supplies; none is in the repository, by rule.

## Order of work

1. **Chunk-backed delivery for Dreamcast.** Download in chunks straight into the emulator frame, attach them as the game file, raise Flycast's limit to what the measured memory allows. Pass CHD through. Accept with one real GD-ROM CHD on the owner's machine. Smallest step that makes large Dreamcast games start.
2. **The block store.** Layer 2, shared by every emulator; a second launch reads nothing from the network.
3. **On-demand for Dolphin.** It already runs in a worker with shared memory and reads RVZ and CISO itself. This is the iCube behaviour in the browser.
4. **Container readers in WebAssembly**, first for the server's scan (identify compressed discs by their headers), then for emulators that cannot read a container themselves.
5. **Expanded copies of ZIP and 7z discs** on the server, and GD-ROM in the CHD converter for the emulators that need CUE and BIN.
6. On-demand for Flycast, which means rebuilding it to run in a worker. Only if step 1 proves too heavy on memory.

Steps 1 and 2 are contract-free. Step 4 adds an optional field to the emulator profile and gets a review; step 5 touches storage and gets one too.

## Not in this design

- Decompressing on the server and streaming the result as the normal path. It moves the work to the server and sends more bytes; it is kept for containers that cannot be read any other way.
- Service workers. The page's content policy and the cost of getting invalidation right are the same objections as in the transfer design.
- Anything for the native apps. iCube already does this; Provenance would use its own reader.
