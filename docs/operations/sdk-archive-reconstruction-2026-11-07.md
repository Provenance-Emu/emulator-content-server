# Independent SDK library reconstruction — November 7

All twelve SDK library archives requested by the retained custom/upstream link
recipes now have independent source-build reconstructions matching their complete
installed bytes. This is not equality after stripping debug information.

The [hosted standard-library build](https://github.com/Provenance-Emu/emulator-content-server/actions/runs/42348454375)
reconstructed eleven archives from a fresh, hash-verified Emscripten source
extraction and an empty private cache:

- `libGL-webgl2.a`, `libal.a`, `libc++-noexcept.a`, `libc++abi-noexcept.a`
- `libc.a`, `libcompiler_rt.a`, `libdlmalloc.a`, `libfetch.a`
- `libhtml5.a`, `libsockets.a`, `libstubs.a`

Every whole archive and all 1,298 member objects match their baseline bytes,
including the 335 members selected by the earlier custom link audits. All 1,298
compiler commands succeeded; 2,385 unique source/header snapshots were retained
and rehashed after artifact download. The source archive is Emscripten revision
`19607820c447a13fd8d0b7680c56148427d6e1b8`, with SHA-256
`efb1f8655b3a2de7fa7ae543dab76547cd2dae8d3eabdd3f5203ba380953d652`.

Two historical build inputs required explicit reproduction. The original SDK
archive member naming used the pinned recipe's case-insensitive filesystem
branch. A recorded Linux adapter selects that branch without changing source
files. The original debug information also names Clang's header directory as
`/opt/s/w/ir/x/w/install/lib/clang/18/include` in 211 objects. The compiler wrapper
maps the new header path to that observed debug path. It changes no source,
optimization setting, runtime file-prefix mapping or binary output afterward.

An earlier hosted source build without the header debug mapping matched five
whole archives and 257 selected members. Its mismatch receipt remains in the
report. An initial setup failure from invoking a resolved `wasm-ld` symlink as
generic `lld` is also retained. The successful run preserves the invoked driver
name while hashing its resolved executable. Neither failed run is counted as a
successful reconstruction.

The twelfth archive, zlib 1.2.13 `libz.a`, was separately rebuilt on macOS from its primary
source archive in a fresh private cache. All fifteen members and the whole archive
match SHA-256 `f729df8cfe71fb428c82a9a938e639354a09c371ddbe824b092e9438afdd3c62`
(288,016 bytes), including all debug sections. Three observed debug path mappings
reproduce the original source/working-directory names. All 65 used source/header
inputs remained unchanged. An earlier environment-only mapping attempt was
ineffective because the pinned SDK intentionally clears `EMCC_CFLAGS`; it remains
recorded separately. The exact run used an explicit captured compiler adapter.

`sdk-archive-reconstruction-2026-11-07.json` retains the receipts, complete pins,
per-member comparisons, failed controls, tools, source inputs and self-contained
zlib reproduction recipe. The standard-library workflow and its pinned plan are
committed alongside it. Diagnostic section comparisons never replace the whole
archive equality gate.

This closes independent source reconstruction for these twelve linked SDK
libraries. The native LLVM/Clang, Binaryen and Node tools remain the pinned
prebuilt SDK, not a fresh native-toolchain bootstrap. Broader component notice
applicability and the VitaQuake2/FinalBurn Neo runtime mismatches remain separate
open scopes. No catalog runtime bytes or verification levels were changed by this
SDK audit.
