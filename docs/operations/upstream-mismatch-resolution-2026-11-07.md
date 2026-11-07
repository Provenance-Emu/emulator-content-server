**Upstream mismatch investigation, 2026-11-07**

The cumulative reconstruction result is 48 exact runtime pairs out of 50. VitaQuake2 and FBNeo still differ from their original pins. This batch adds structural comparisons, controlled linker attribution, and a correction to an effective-heap field in the previous report.

| Runtime | Pinned WASM bytes | Latest rebuilt WASM bytes | Result |
| --- | ---: | ---: | --- |
| VitaQuake2 | 4,546,368 | 4,546,370 | JS exact, WASM differs |
| FBNeo | 42,222,119 | 42,222,475 | JS and WASM differ |

Vita's original and rebuilt modules each define 6,468 functions. Their opcode/type/local-shape multisets agree. Across 4,919 uniquely paired shapes, 6,047 changed integer occurrences have consistent bijective mappings, comprising 5,764 uninitialized-data-address candidates, 259 function-table indices with matching target shapes, 19 initialized-data-address candidates and five negated-address candidates. All 650 changed direct references in those pairs target matching shapes. These diagnostics support investigating layout and ordering while the exact byte comparisons retain their mismatch result.

A fresh link using retained objects and a private SDK cache reproduces both previous Vita output files byte-for-byte. A compiler wrapper rejects compilation requests. The controlled map replay preserves the entire preoptimizer WASM, and each of three passes retaining diagnostic names preserves every executable section. The resulting map gives unique input ownership for 6,448 functions, including 1,628 core functions. Optimizer ordering interleaves source objects, and changed-address constraints recover only a partial historical member order. The full 167-member archive order remains unresolved, so the investigation concludes with these constraints.

The prior Vita field `buildRecipeEvidence.effectiveFrontendHeapBytes` recorded the requested `MEMORY=402653184` argument. Pinned `Makefile.emscripten` instead reads `INITIAL_HEAP`, whose effective value in the recorded linker response is 134,217,728 bytes. Both original and rebuilt memory sections encode that same value and compare byte-for-byte. The JSON binds the exact previous document hash, field path, source lines 129/189, linker response and corrected value. The previous document retains its frozen bytes.

FBNeo's repeated corrected Linux recipe reproduces the same mismatching files as its prior attempt. All 30 differing JavaScript bytes occur in nine `ASM_CONSTS` address keys, each shifted by exactly 144. The other bytes compare equal. Both WASMs define 102,390 functions. Eleven opcode/type/local-shape occurrences per side remain unmatched. The code section grows by 42 bytes and the data section by 314 bytes, accounting for the 356-byte total difference. Import, table and memory sections compare exactly. Printable payload differences include binary-prefix/string-boundary fragments; the complete samples and unmatched-function numeric metadata are retained.

The 357,418,109-byte hosted structural artifact is hash-verified. Bounded workers extract summaries and unmatched functions with measured resident memory below 40 MiB against a 1,280 MiB budget. The hosted source/header capture, manifests and command logs are independently rechecked, and their input tuples equal the prior corrected recipe. Runtime byte comparisons execute on the runner against verified original archive members.

The datasets record the precise collector versions used. The current collector creates output exclusively and passes seven self-tests, including existing-file, same-path, symlink and hardlink cases. Diagnostic normalization preserves explicit scope and supports correspondence analysis. Both runtime profiles retain `sourceMapping: unverified`.

The JSON records exact resource pins, source archives, commands, tool/source versions, heap-field correction, controlled replay receipts and retained artifact hashes. Shared SDK archive source reconstruction has its own hash-bound report. Historical input identity and complete final-code notice scope remain open.
