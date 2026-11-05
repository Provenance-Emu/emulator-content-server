# Dolphin: disk-backed large discs and Wii execution

Follow-up: [the current full-size acceptance](browser-more-systems-2026-10-31.md#large-disc-acceptance-quota)
passes with a fresh persistent headless profile. Temporary-context storage limits
and their user-facing guidance are documented there.

The operator-local Dolphin profile now accepts files up to **9 GiB** and advertises
GameCube and Wii. Silent headless ECS acceptance passed three independent cases:
an original GameCube DOL, a Wii DOL, and a full-size **1,459,978,240-byte GameCube ISO**.
All used the normal authenticated library/source client, private runtime port,
separate loopback origin, real JIT, positive XFB output and native controller poll.
The three cases completed in 13.8 seconds; [aggregate receipts](dolphin-large-wii-2026-10-31.json)
record actual pixels, dispatch counts and pressed/released controller masks.
No ROM, firmware or commercial disc bytes are in the fixtures.

## Large-file path

Dolphin files above 32 MiB stream through the existing resumable `downloadTo` or
`downloadSourceTo` client into an origin-private browser file. Writes have
backpressure and bounded 64 KiB copies. A changed representation truncates the
staging file before retry; cancellation, short/oversized input, verification failure
and normal session teardown remove that session's staging file. Quota is checked
before downloading; unavailable or insufficient browser storage fails explicitly.
There is no fallback that collects a multi-gigabyte disc into JavaScript memory.
New staging files use an origin-scoped Web Lock for the whole playback lifetime.
On a later launch, bounded scavenging removes only recognized files whose lock is
available. Live tabs retain their files. Browsers without a lock service use a
separate non-reclaimed namespace, and legacy staging files are not touched. The maximum is a supported file-size bound,
not a claim that every 9 GiB image or mobile device is qualified.

The browser passes a readonly File snapshot to the companion, then its dedicated
main-core worker mounts it through the pinned module's existing WORKERFS. Its
FileReaderSync reads Blob slices on demand. The disc is not copied into MEMFS or
WASM linear memory; the existing core still reserves a fixed 1.5 GiB shared heap.
The original ISO has its own original PPC apploader, DOL and FST. Its native boot
and production browser boot establish that large files traverse the real disc
reader, rather than a padded executable or host-generated replacement frame.

The first-party worker is a closed serialized function supplied over the existing
private port. The frame retains canvas, input bridge and audio presentation; core
ABI, filesystem and pthread work run off the UI thread. One tick is in flight at
a time, and bounded owned video/audio buffers cross the worker boundary. Paths,
file size, core hashes, replies and resource lookups remain constrained. Teardown
terminates the worker/pthreads and unmounts the file. Non-Dolphin profiles keep the
512 MiB limit and original opaque worker-free sandbox.

## Wii qualification

The [Wii proof](dolphin-wii-acceptance-2026-10-31.md) independently verifies 729 MHz
Wii timing, HLE IOS58, MEM2 read/write, actual VI output and the existing GameCube
controller bridge. The same generated Wii executable also passed the full ECS page.
Dolphin detects this executable's Wii HID4 instruction; no Nintendo NAND, keys or
firmware are supplied. The core and loader hashes are unchanged from the initial
Dolphin profile.

**Wii Remote input is unavailable.** Current controls are a GameCube-controller
fallback for compatible homebrew/titles. Encrypted Wii-disc compatibility, installed
WAD/NAND applications, GX game rendering, audio quality, physical controller
acceptance, more controllers and synchronized saves remain unqualified or deferred.
The catalog must not present those as verified features. This is an experimental
operator-local package pending a clean corresponding-source rebuild for distribution.

## Validation

Focused tests cover streamed staging, retries, quota/cancellation/size failures,
cleanup before core import, runtime-specific size limits, unsafe mount paths,
readonly multi-gigabyte File slicing, worker bounds and teardown. The headless
browser cases cover actual frontend selection, authenticated transfer, disk-backed
boot, Wii boot, JIT/video and core controller press/release. No foreground/native
browser testing or OS/browser security-setting changes are used.


A deferred capture issue is also addressed: screenshot RPC pauses a previously
running core before copying an owned positive-XFB frame, then resumes it in a
finally block. An already paused core stays paused. Failure-path tests verify
resume behavior; a focused silent headless case produced a 320×240 PNG and verified
that JIT execution continued afterward. Ordinary display ticks remain asynchronous.
Dynamic game scene synchronization and audio quality remain unqualified.


The cleanup change passed eight focused staging/locking/quota regressions and a
silent headless 64 MiB disc boot, capture and controller test. A repeat of the full
1.46 GB test at this later point hit the machine/browser storage quota after about
239 MiB; its partial file was removed. This is separate from the earlier successful
full-disc acceptance. The smaller explicit fixture exercises the same OPFS/File/
WORKERFS/lock path within the available quota. The public 9 GiB maximum does not
reserve disk capacity; real quotas/free space can change after an initial estimate,
and mid-stream exhaustion now gives an actionable disk-space message.
