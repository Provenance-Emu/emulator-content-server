# SHA1 and IJG notice resolution, 2026-11-06

The matching historical distributions supply both previously missing grant texts.
The companion JSON records archive hashes, member names, source/header spans and
explicitly bounded code comparisons. Earlier immutable audit records remain
historical checkpoints.

## Paul E. Jones SHA1

The author's source archive contains the same June 2009 revision header incorporated
in `libretro-common/hash/lrc_hash.c`. Its SHA1 fingerprint matches the fingerprint
published by the author. Two substantial executable-code spans match after the
enumerated field renames and removal of comments and whitespace. All ten custom
frontend copies have identical bytes. The accompanying grant is named Freeware
Public License (FPL). Its original wording is retained in
[sha1-fpl.txt](notices/sha1-fpl.txt). The outer frontend MIT notice and this
incorporated grant remain individually identified. [Author's distribution](https://www.packetizer.com/security/hash/sha1/)

## PCFX inverse DCT

The original IJG release 4 source archive contains the byte-identical 1991/1992
header and its referenced README. Substantial row and column transform spans
match the incorporated Mednafen source with only comments, whitespace and the
`INT32` to `int32` identifier change normalized. The full original README is
retained byte-for-byte in [ijg-v4-README.txt](notices/ijg-v4-README.txt).
This copy was recovered from the Funet historical mirror. A publisher signature
was unavailable. [Historical distribution](https://ftp.funet.fi/index/pics/viewers/unix/jpeg/jpegsrc.v4.tar.Z)

This software is based in part on the work of the Independent JPEG Group.

### Incorporated modifications

The compared Mednafen file identifies its adaptation as modified in 2007. Relative
to release 4 `jrevdct.c`, the incorporated file changes the following areas.

- Replaces `jinclude.h` with Mednafen type and local DCT headers, fixes `DCTSIZE`
  at eight and uses `int32` for intermediate values and constants.
- Fixes `PASS1_BITS` at two, adds a precision-bound check, supplies a direct
  signed right-shift macro and removes the alternate sample-size and specialized
  multiplication configurations.
- Removes the `GLOBAL` declaration marker and `SHIFT_TEMPS` compatibility helper.
- Deletes the zero-AC row and column shortcuts, including their commentary.
- Changes final column descaling from `CONST_BITS+PASS1_BITS+3` to
  `CONST_BITS+PASS1_BITS+1`, and adjusts formatting and type-name comments.

The machine report identifies both complete file hashes and the retained diff.
This documents the compared changes without attributing them to a newly established
historical author. The IJG README requires this README to accompany source
redistribution, clear change documentation and attribution in executable-only
documentation. It also contains responsibility, warranty and publicity conditions.

## Remaining distribution work

These materials close grant-text recovery for these two components. Existing
published core packages and separately hosted source archives retain their prior
contents. Future redistribution must carry the applicable retained texts,
attribution and modification documentation. Final-code scope and independent SDK
source reconstruction remain open in the component audit.
