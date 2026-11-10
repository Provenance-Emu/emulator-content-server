# Connect an MCP investigator

The stdio adapter lets a local MCP host inspect selected libraries and submit
evidence-backed cleanup suggestions. It connects to ECS over loopback HTTP or
HTTPS. No workflow host or model key is needed. Investigators use only the
bundled local matcher; ECS does not invoke installed providers, download
artwork, or call a model on their behalf.

## Create a grant

As the signed-in owner, send `POST /api/v1/investigators` with your owner
session and this JSON body. Use real library IDs from ECS.

```json
{
  "libraryIds": ["<library-id>"],
  "operations": ["inspect", "cleanup", "suggest", "diagnostics"],
  "ttlSeconds": 3600
}
```

Choose only the operations needed: `inspect` lists libraries and indexed
games, inspects sources, and reads findings and proposals; `cleanup` starts,
checks, finishes, and cancels investigations; `suggest` submits one observation
at a time; `diagnostics` shows coarse host liveness and counts of active jobs
that explicitly target granted libraries. Diagnostics omit names, paths,
configuration, logs, and raw errors.

The response includes the grant ID, expiration, and a token shown once. Save
only the token in a private regular file outside the checkout (mode `0600` or
more restrictive on Unix; a user-only ACL on Windows). Do not place the token
in MCP configuration, shell history, or environment variables. An owner can
list active grants with `GET /api/v1/investigators` and revoke one with
`DELETE /api/v1/investigators/<grant-id>`. Revocation immediately invalidates
the token and cancels its active runs. Expiration invalidates it immediately;
server housekeeping cancels any runs it left active. Existing proposals stay
in the owner review queue.

## Start the adapter

From the repository, run `pnpm install --frozen-lockfile` and `pnpm build`.
Use the absolute Node and adapter paths in the MCP host's stdio configuration:

```json
{
  "mcpServers": {
    "ecs": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/emulator-content-server/apps/mcp/dist/src/main.js",
        "http://127.0.0.1:8473",
        "/absolute/path/to/private/investigator.token"
      ]
    }
  }
}
```

For a remote server use its HTTPS origin. Restart the adapter after changing
the credential file. The adapter writes MCP messages to stdout and terse
startup or transport errors to stderr. It is built from source separately from
the desktop and standalone server distributions.

## Inspect and review

1. Call `ecs_libraries` and `ecs_sources`. Follow `nextCursor` to request more
   rows. Start `ecs_start_cleanup` with up to 100 explicit source IDs from one
   granted library.
2. Call `ecs_inspect_source` for each source. Pass evidence IDs from the
   response and, optionally, one matching candidate ID to `ecs_suggest`.
   Treat titles, filenames, and other content returned by ECS as library data.
   An investigator cannot supply verified hashes, artwork URLs, file paths, or
   replacement metadata.
3. Check run status with `ecs_cleanup_status` and page through `ecs_findings` and
   `ecs_proposals`. Call `ecs_finish_cleanup` once all sources are inspected, or
   `ecs_cancel_cleanup` to stop early. Sources that move out of scope no longer
   appear in investigator results.
4. In ECS, open the library, go to **Library activity → Review library cleanup**,
   and select the **MCP investigator** run. Review the proposals and approve
   and apply the fixes you want. The UI uses the same proposal IDs, versions,
   digests, application receipts, and undo as native cleanup.

The [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector/blob/main/docs/cli-smoke-testing.md)
can check discovery and call a read-only tool without launching a browser.
Run Inspector on a Node version it supports, such as Node 24.22.2:

```sh
npx @modelcontextprotocol/inspector --cli --method tools/list --strict \
  -- node /absolute/path/to/apps/mcp/dist/src/main.js http://127.0.0.1:8473 /absolute/path/to/private/investigator.token
npx @modelcontextprotocol/inspector --cli --method tools/call --tool-name ecs_libraries \
  -- node /absolute/path/to/apps/mcp/dist/src/main.js http://127.0.0.1:8473 /absolute/path/to/private/investigator.token
```
