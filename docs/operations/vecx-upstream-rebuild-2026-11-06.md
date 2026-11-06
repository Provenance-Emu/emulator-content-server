# VecX upstream reconstruction, 2026-11-06

Both exact pinned upstream runtime files were independently rebuilt byte-for-byte.
The companion JSON records source archive URLs and hashes, commands, environment,
1,071 compiler input hashes and both original/output resource hashes.

| Input | Revision |
| --- | --- |
| libretro/libretro-vecx | `dccff5402a16d1ea7c112095a8e42632bf149506` |
| libretro/RetroArch | `6ebf66b6433235d582e627fc802ff4b966613720` |
| SDK | Emscripten 3.1.46 |
| Build date | October 30, 2026, via `SOURCE_DATE_EPOCH=1793318400` |

Fresh source archives supplied every core/frontend compiler input, with no source
patches or generated source discrepancies. The existing SDK installation supplied
the system inputs. Two make jobs and two Binaryen workers kept the build bounded.
No emulator was launched.

| Resource | Bytes | SHA256 |
| --- | --- | --- |
| `vecx_libretro.js` | 270600 | `5958953792f9a344d9c8b56253d7a47e2708e780763391858b23ed52e9ea9880` |
| `vecx_libretro.wasm` | 3654683 | `8e416a70bf3de29666251104ab9bd1a4100ce97862a5d545ab518620a893564d` |

The comparison used both hashes and direct byte equality against the retained
October 31 archive pair. This establishes one executable reconstruction. The
historical job/container identity, independent SDK source reconstruction and full
component-specific final-code notice mapping remain open. All fifty catalog
entries retain `sourceMapping: unverified` under the existing complete-mapping
criteria.
