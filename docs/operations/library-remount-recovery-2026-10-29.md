# Library remount recovery and storage interruption — 2026-10-29

## Rescan diagnosis

The matching acceptance earlier on October 29 finished with 430 metadata records
and 261 front covers. A later scan replaced 1,067 source identities after a volume
device number changed. Every affected same-path file retained its inode, birth
time, size and modification time. The old scanner compared the complete device,
inode and birth-time string, so it deleted the old rows and their saved choices.
This was separate from automatic matching, which had preserved existing choices.

The scanner now retains same-path sources within their registered root when only
the device number changes and inode, birth time, size and mtime all agree. The
updated identity still invalidates cached ROM identification stamps. Changed
inodes, birth times, sizes or modification times remain replacements. This does
not add identity transfer across folders or libraries.

## Local recovery

A consistent SQLite backup was taken before recovery. The earlier matching
checkpoint supplied the detached selections. Each destination was checked against
its registered root, contained path, open file descriptor, inode, birth time,
size and mtime before writing. Available whole-file MD5/SHA-1 facts were also
verified against current bytes. Recovery filled empty selection slots using the
catalog's revision checks and change/audit events.

- 201 sources recovered, with 324 selections restored.
- 133 source files additionally passed cached raw hash checks; 68 relied on the
  complete same-path remount identity guards described above.
- All 367 choices present before recovery retained their exact JSON and content.
- Final totals: 430 metadata records and 261 front covers; zero skipped sources.

The private database snapshot and recovery receipt are retained under the ignored
`dist-release/pre-remount-recovery-20261029/` directory. No ROM, firmware, save or
private recovery material is committed.

## Queue interruption

The full-disk issue observed during the original backfill is also fixed. SQLite
storage errors and filesystem space/quota failures pause the worker with pending
items intact. Failure to write the interruption status cannot escape as an
unhandled rejection. All owner sessions see the paused work even if the status
write itself failed. Scan callers are released, and the queue does not spin or
continue through the remaining ROMs on an unwritable disk.

After storage recovers, an explicit resume, cancellation or new job request
persists recovery before restarting work. Failed recovery leaves the worker
paused and returns an actionable 503. Completed outcomes remain completed.

## Verification

The focused server/database suites cover shared cancellation and deduplication,
interrupted queue claims, simultaneous outcome/status write failures, waiting
scan callers, recovery without repeating completed outcomes, and remount versus
replacement identity guards. Package boundaries and secret/fixture scans pass.
The compact matching UI was also verified against the deployed local server.

All 31 focused server/database cases passed. On the updated local server, two
independent owner sessions requested a scan concurrently and shared one durable
job (`reused: false` / `true`). Both folders completed with zero failures. All 691
saved selections retained their exact JSON and content after that scan. Temporary
acceptance sessions were revoked.
