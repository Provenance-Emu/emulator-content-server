# Faster transfers and loads

Status: proposed. Date: 2026-11-21. Stage A is the only part safe to build without a contract or storage change.

## What is slow, and for whom

Four things carry almost all of the waiting in a household library:

1. **Covers in a grid.** Every visit reads every visible cover again. The web interface fetches them with a bearer header and the server sends no cache policy, so nothing is kept between visits.
2. **Large files on the home network.** Hundreds of megabytes to several gigabytes, where the disk is the limit, not the link.
3. **Listings and the interface itself over a remote link.** JSON and the 410 kB script bundle travel uncompressed.
4. **Reading the same bytes twice.** An upload is read back from disk to be hashed, and a server-folder file is probed and recorded on every range of a download.

## What was measured against (2026-11-21 audit)

| Technique | Server | TypeScript client | Web | Swift client |
| --- | --- | --- | --- | --- |
| HTTP/2, HTTP/3 | HTTP/1.1; TLS at a proxy (ADR 0004) | n/a | n/a | default `URLSession` |
| gzip / brotli | none | n/a | none at build | n/a |
| Long-lived caching of immutable bytes | strong `ETag` only | n/a | none | none |
| `ETag` / 304 | blobs, artwork | not used | static plugin only | not used |
| Range and resume | single range | yes | through the client | request built only |
| Parallel segments or chunks | sequential by design | no | no | no |
| Hash while receiving an upload | reads the staged file again | n/a | n/a | n/a |
| Retry with backoff | n/a | retries, no wait | same | none |
| Persistent local cache | n/a | n/a | OPFS discs, IndexedDB journal and skins | none |
| Keep-alive and timeouts | Fastify defaults: connections stay open 72 s, no limit on receiving a body | per-request timeout | n/a | 15 s on pairing only |

`PVWebServer` (the Swift server in Provenance) was the comparison. It is HTTP/1.1 on `NWListener` too: keep-alive with pipelined parsing, `TCP_NODELAY`, 256 KiB streamed reads with send backpressure, 4 MiB upload reads written straight to disk, an early `100 Continue`, and separate queues for disk and directory work. It has no compression, no cache validators, no HTTP/2 or HTTP/3, and no parallel transfers. Its lessons are about backpressure and not buffering, which this server already follows (1 MiB stream reads piped to the socket, resumable chunked uploads).

## Decisions

### Do not add: in-process HTTP/2 or HTTP/3, pipelining, multi-range, parallel segments

- **HTTP/2** reaches a browser only over TLS. This server speaks plain HTTP and leaves TLS to a proxy by decision (ADR 0004); doing both would mean issuing and renewing certificates for home addresses. **HTTP/3** has no stable server in Node 22. A proxy in front (Caddy, for example) already gives remote clients HTTP/2, HTTP/3 and its own compression, and `docs/operations/remote-access.md` should carry a tested recipe. Apple clients then negotiate both on their own.
- **Pipelining** is off in every browser and in `URLSession`. What it promised is delivered by keep-alive, which is already on: an idle connection stays open for 72 seconds, longer than any client's poll.
- **Parallel range segments** help when the link is the limit. At home the disk is, and several readers on one spinning disk are slower than one. **Multi-range** has no client that would ask for it.

### Stage A: no contract change

1. **Cache the interface properly.** Hashed files under `/ui/assets/` get `cache-control: public, max-age=31536000, immutable`; the HTML documents get `no-cache`.
2. **Ship the interface compressed.** After the web build, write `.br` and `.gz` beside every text asset and let the static plugin serve them (`preCompressed`). No runtime cost.
3. **Compress listings.** Brotli (quality 4) or gzip for JSON a client reads, over 1 KiB, when it accepts it. Only `GET` answers: everything that hands out a credential is a `POST`. Never a response marked `no-store`, and never file content (already compressed, and it has to keep its ranges).
4. **Wait before retrying.** The TypeScript client parses `Retry-After` and then retries at once. Sleep for it, with a short capped backoff otherwise.
5. **Small web wins.** `decoding="async"` on covers and pictures; `modulepreload` for the player entry.

### Stage B: additive contract

6. **Immutable content URLs.** Bytes are addressed by SHA-256, but the content URL is keyed by asset id, whose bytes can be replaced, so it cannot be cached forever. Add an optional `v=<sha256>` to the content routes: when it equals the current hash the answer is `cache-control: private, max-age=31536000, immutable`; otherwise today's behaviour plus an explicit `private, no-cache`. Clients already hold the hash (manifest files, preview assets). A hash is not a credential. Result: a cover is read once per device, and a return visit to a library reads none.
7. **Swift client transport.** One configured `URLSession` in place of `.shared`: `waitsForConnectivity`, six connections per host, a `URLCache` sized for covers so item 6 applies there too, and `assumesHTTP3Capable` for HTTPS origins.

### Stage C: storage, needs a review

8. **Hash an upload while writing it.** Completion currently reads the whole staged file again to compute SHA-256, which doubles disk reads for a multi-gigabyte game. Keep a running hash for the upload in memory and fall back to the re-read when the process restarted mid-upload. Durability rules (fsync, staging, content addressing) do not change.
9. **Stop writing on every read of a server-folder file.** `sendSourceContent` probes the disk and calls `updateSourcePresence` on each request, including each range of one download. Record presence only when it changes.

## Order and checks

Stage A first, in one change with tests for: a compressed listing and an uncompressed credential response; an untouched ranged download; `immutable` on a hashed asset and `no-cache` on the document; a precompressed asset served to a client that accepts it; a retry that waits. Stage B follows the contract-change steps and updates `docs/protocol/client-integration.md`. Stage C gets one `ecs-reviewer` pass.

Not planned: a service worker (the page's content policy and the cost of getting invalidation right outweigh item 6), and server-side image resizing (worth revisiting only if covers stay slow after item 6).
