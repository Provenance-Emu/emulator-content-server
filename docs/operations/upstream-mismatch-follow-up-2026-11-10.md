# Upstream core mismatch follow-up, November 10, 2026

## FinalBurn Neo function correspondence

The [retained Linux comparison](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/42347211935)
matches its recorded 357,418,109-byte size and SHA-256
`9c8a0f76e3df88d9a908bb36af7187ebcfce6514be22419c64c37faebb4e3c9f`.
Its receipt also matches the hash in the
[November 7 machine report](./upstream-mismatch-resolution-2026-11-07.json).
The comparison has 11 unmatched opcode-shape occurrences on each side.

Reference context yields one candidate counterpart for each unmatched
function. For seven pairs, a caller with a shape unique in both modules
references the candidate at the same instruction ordinal. The other four
have equal outgoing reference counts and share at least two aligned
references to targets with a shape unique in both modules. No other pair of
unmatched functions met either rule.

| Pinned function index | Rebuilt function index | Matched caller sites | Aligned references to unique target shapes | Total outgoing references per side |
| ---: | ---: | ---: | ---: | ---: |
| 1723 | 1723 | 11 | 17 | 127 |
| 3405 | 3409 | 4 | 140 | 209 |
| 4325 | 4331 | 2 | 24 | 26 |
| 5782 | 5739 | 2 | 180 | 180 |
| 8125 | 8045 | 1 | 4 | 4 |
| 8126 | 8046 | 1 | 13 | 19 |
| 8420 | 8376 | 2 | 41 | 57 |
| 25973 | 26679 | 0 | 16 | 22 |
| 25975 | 26682 | 0 | 77 | 79 |
| 25998 | 20044 | 0 | 3 | 3 |
| 25999 | 20045 | 0 | 5 | 5 |

Table slots alone did not yield a candidate pair. Of 100,230 shared slots,
42,855 had matching nonempty shapes and none paired two unmatched functions.
The static reference evidence narrows source attribution and disassembly to
these 11 candidate pairs. FBNeo still differs from the pinned runtime, and
the candidates do not establish function equivalence or source ownership.

To reproduce, use Python 3.11 or newer with `ijson 3.6.0` in an isolated
environment. Download the run's artifact into a new external directory and
pass its comparison file to the reader:

```sh
gh run download 42347211935 --name fbneo-linux-diagnostic-42347211935 --dir /absolute/new-evidence-directory
python scripts/browser-core/correlate-fbneo-mismatch.py /absolute/new-evidence-directory/runtime-comparison.json
```

The reader checks the size and SHA-256 before parsing and streams function
records. Its JSON output lists the caller fingerprints and target reference
ordinals for independent inspection. Preserve the artifact outside the
checkout if it is needed after GitHub's retention period.

## VitaQuake2 reconstruction control

A fresh arm64 macOS run of
[`reconstruct-vitaquake2.py`](../../scripts/browser-core/reconstruct-vitaquake2.py)
used the activated Emscripten 3.1.46 SDK, verified the dated archive and source
tarballs, and captured 502 compiler invocations and 1,319 distinct source or
header snapshots. Both outputs match the previous reconstructed pair.

| Resource | Pinned bytes | Rebuilt bytes | Rebuilt SHA-256 |
| --- | ---: | ---: | --- |
| JavaScript | 270,624 | 270,624 | `e08efe6b2e892a5d4fafe81f0a3f16dd080746660dece9731859d7bec0c817d1` |
| WASM | 4,546,368 | 4,546,370 | `3ef5e2579008d4355675724036ec02d9955e67f33b45df8ce1796a61c3e8f4ae` |

The JavaScript matches the official bytes. The pinned WASM SHA-256 is
`30ea55b6256cbd5aa8a5f8fd8a58ca34b0bb4f7c72c462ec3888465e7a8a9e83`.
The fresh archive contains 167 members and puts `rand.o` directly before
`shared.o`. The November 7 evidence suggests testing the reverse order.

A link-only control in a copy of the fresh build reproduced both output
files byte-for-byte. The variant used
`llvm-ar mb rand.o libretro_emscripten.a shared.o` before replaying the same
frontend link. All 167 member payload hashes were identical across the
archives. Only positions 120 and 121 changed.

| Compared with the pinned WASM | Control | Swapped order |
| --- | ---: | ---: |
| Exact function bodies at the same index | 5,425 | 5,441 |
| Unique shape pairs with different function-reference operands | 364 | 353 |
| Unique shape pairs with different integer operands | 687 | 687 |
| Unmatched reference fingerprints per side | 827 | 827 |

The swap kept the JavaScript exact and produced a 4,546,370-byte WASM with
SHA-256 `6d14c5839b6077e55fe7b898be4cb5176de52d84dc685345f37d3605770a2986`.
It moves some function references closer to the original layout while
leaving the WASM mismatch and the integer-operand gap open. This experiment
does not establish the complete historical member order.

The two mismatches still leave 48 exact pairs out of 50. Full source and
notice mapping remains a separate acceptance item.
