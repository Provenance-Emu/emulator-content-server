#!/usr/bin/env node
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ContentClient, ContentError } from '@ecs/client';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

async function readCredential(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 128 ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw new Error('Use a private regular file owned by the current user');
    const bytes = Buffer.alloc(129);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const token = bytes.subarray(0, size).toString('utf8').trim();
    if (size > 128 || !/^ecs_inv_[A-Za-z0-9_-]{43}$/.test(token))
      throw new Error('Invalid credential file');
    return token;
  } finally {
    await file.close();
  }
}

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
const paging = {
  cursor: z.string().min(1).max(160).optional(),
  limit: z.number().int().min(1).max(20).optional(),
};
const run = { runId: id };
const kind = z.enum([
  'identity-conflict',
  'suspected-mismatch',
  'missing-front-artwork',
  'questionable-front-artwork',
  'unavailable-selected-artwork',
]);
function createServer(client: ContentClient): McpServer {
  const server = new McpServer({ name: 'ecs-investigator', version: '0.1.0' });
  function tool<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    readOnly: boolean,
    execute: (args: z.output<z.ZodObject<S>>, signal: AbortSignal) => Promise<object>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: z.strictObject(shape),
        annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false },
      },
      async (args, context) => {
        try {
          const result = await execute(args, context.mcpReq.signal);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: { ...result },
          };
        } catch (error) {
          const messages: Record<number, string> = {
            400: 'ECS rejected the input or evidence.',
            401: 'The investigator credential is invalid, expired or revoked.',
            403: 'The investigator credential lacks this operation.',
            404: 'The resource is unavailable to this investigator.',
            409: 'The run or source changed, or cleanup is already active.',
            429: 'ECS is busy or a quota was reached.',
          };
          const text =
            (error instanceof ContentError ? messages[error.status] : undefined) ??
            'ECS could not complete the request.';
          return { isError: true, content: [{ type: 'text', text }] };
        }
      },
    );
  }
  tool('ecs_libraries', 'List libraries in the investigator grant.', {}, true, (_, signal) =>
    client.investigatorLibraries(signal),
  );
  tool(
    'ecs_sources',
    'List indexed game sources in one granted library. Use nextCursor to continue.',
    {
      libraryId: id,
      ...paging,
    },
    true,
    ({ libraryId, ...page }, signal) => client.investigatorSources(libraryId, page, signal),
  );
  tool(
    'ecs_start_cleanup',
    'Start an offline cleanup investigation of up to 100 selected sources in one library.',
    {
      libraryId: id,
      sourceIds: z.array(id).min(1).max(100),
    },
    false,
    (args, signal) => client.startInvestigatorRun(args, signal),
  );
  tool(
    'ecs_cleanup_status',
    'Read the state of an investigation started by this credential.',
    run,
    true,
    ({ runId }, signal) => client.investigatorRun(runId, signal),
  );
  tool(
    'ecs_cancel_cleanup',
    'Stop an investigation. Existing suggestions remain available for owner review.',
    run,
    false,
    ({ runId }, signal) => client.cancelInvestigatorRun(runId, signal),
  );
  tool(
    'ecs_finish_cleanup',
    'Complete an investigation after inspecting all selected sources. Suggestions remain available for owner review.',
    run,
    false,
    ({ runId }, signal) => client.finishInvestigatorRun(runId, signal),
  );
  tool(
    'ecs_inspect_source',
    'Collect facts and local candidate evidence for one source in an active investigation.',
    {
      ...run,
      sourceId: id,
    },
    false,
    ({ runId, sourceId }, signal) => client.inspectInvestigatorSource(runId, sourceId, signal),
  );
  tool(
    'ecs_findings',
    'Page through findings for sources still in scope.',
    { ...run, ...paging },
    true,
    ({ runId, ...page }, signal) => client.investigatorFindings(runId, page, signal),
  );
  tool(
    'ecs_proposals',
    'Page through proposal identities and versions for sources still in scope.',
    { ...run, ...paging },
    true,
    ({ runId, ...page }, signal) => client.investigatorProposals(runId, page, signal),
  );
  tool(
    'ecs_suggest',
    'Submit an observation with evidence IDs from inspection and at most one candidate. ECS owners review and apply proposals.',
    {
      ...run,
      sourceId: id,
      kind,
      reason: z.string().min(1).max(512),
      evidenceIds: z.array(id).min(1).max(5),
      candidateIds: z.array(id).max(1),
    },
    false,
    ({ runId, ...suggestion }, signal) =>
      client.submitInvestigatorSuggestion(runId, suggestion, signal),
  );
  tool(
    'ecs_diagnostics',
    'Read coarse host liveness and counts of active jobs explicitly scoped to granted libraries.',
    {},
    true,
    (_, signal) => client.investigatorDiagnostics(signal),
  );
  return server;
}

async function main() {
  const [address, file, ...rest] = process.argv.slice(2);
  if (!address || !file || !isAbsolute(file) || rest.length)
    throw new Error('Missing configuration');
  const base = new URL(address);
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))
  )
    throw new Error('Use HTTPS for a remote server');
  const client = new ContentClient(base.origin, await readCredential(file), { timeoutMs: 20_000 });
  serveStdio(() => createServer(client), {
    onerror: () => process.stderr.write('ECS MCP transport error\n'),
    maxSubscriptions: 16,
  });
}
try {
  await main();
} catch {
  process.stderr.write(
    'Usage: ecs-mcp <server origin (HTTPS or loopback HTTP)> <absolute path to a private investigator credential file>\n',
  );
  process.exitCode = 1;
}
