# Downloading game files

The file and source endpoints remain authenticated API operations. Download controls never put bearer credentials in URLs or follow a content-path URL supplied by metadata.

## Direct saving

The current source uses the browser's Save File Picker when available. Choose a destination and the client writes incoming bytes to its staging writer with backpressure. Each pending write is at most 64 KiB. The client keeps a byte count and a strong ETag so a dropped network transfer can resume; changed content or an ignored range resets the staging file. Only a complete, validated transfer closes the writer and commits the chosen file. A disk error, rejected account, canceled picker, obsolete detail or navigation away aborts it.

This needs a browser that exposes the File System Access save picker, usually Chrome or Edge in a secure context. HTTPS works; localhost/127.0.0.1 on the server computer also qualifies. Ordinary remote LAN HTTP and the current macOS WebKit desktop window use the fallback instead. The API does not retain destination handles or request permission across reloads.

## Buffered fallback

Browsers without direct saving keep the normal Download behavior for files up to 256 MiB. Known larger files are rejected before requesting their content, with instructions for using a browser that can save directly. The client also checks headers and actual received bytes, so a missing or inaccurate size cannot create an unlimited allocation. ZIP fallback downloads are bounded too, including streamed ZIP bodies without Content-Length. Leaving a detail cancels its active file request.

This limit applies to the UI's buffered fallback, not API clients writing to their own filesystem or direct browser disk saving. Persistent upload queues are a separate remaining feature; selecting files and retry state still lasts only until the page closes.

## Validation and release scope

The download follow-up passed 92 TypeScript client tests, 207 web controller tests, 22 focused real-server browser cases, both Svelte checks and production frontend builds. Streaming browser cases replace only the save-picker/writer transport; authentication, file requests and byte checks use a real disposable server. They do not establish live OS file-picker acceptance in every browser. Tests cover backpressure, safe resume/restart, changed validators, byte limits, disk errors, canceled/stale pickers, stalled-stream disposal and 401/403 rejection without committing a destination.

These download changes follow the published 0.1.2-alpha.1 installer refresh. That release contains the new library UI; this later source change is intended for the next release.
