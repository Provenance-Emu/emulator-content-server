import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { WorkflowManifestV2 } from '@ecs/plugins/workflows';
import { activateWorkflowPackage, installWorkflowPackage } from './packages.js';

export const CLEANUP_MANIFEST: WorkflowManifestV2 = {
  id: 'org.ecs.library-cleanup',
  name: 'Library cleanup',
  version: '1.0.0',
  engine: 'ecs.plugin/2',
  hostApi: '^1.0.0',
  kind: 'workflow',
  entry: 'workflow.mjs',
  inputSchema: 'schemas/input.json',
  outputSchema: 'schemas/output.json',
  effects: ['library.read', 'proposal.create'],
  bindings: { catalog: { capability: 'catalog.search', major: 1 } },
};

/** Default integrations use the exact immutable package/activation path used by community modules. */
export async function installBundledCleanup(stateDirectory: string) {
  const bytes = await readFile(new URL('./cleanup/workflow.js', import.meta.url));
  const input = Buffer.from(
    JSON.stringify({
      type: 'object',
      required: ['source', 'scope', 'options'],
      additionalProperties: false,
      properties: {
        source: {
          type: 'object',
          required: ['sourceId'],
          properties: {
            sourceId: { type: 'string' },
            indexValidator: { type: 'string' },
            selectionRevision: { type: 'integer' },
            state: { type: 'string' },
          },
          additionalProperties: false,
        },
        scope: { type: 'object' },
        options: { type: 'object' },
      },
    }),
  );
  const output = Buffer.from(
    JSON.stringify({
      type: 'object',
      required: ['unresolved'],
      additionalProperties: false,
      properties: {
        unresolved: { type: ['string', 'null'] },
        problems: {
          type: 'array',
          items: {
            type: 'object',
            required: ['providerId', 'code'],
            properties: { providerId: { type: 'string' }, code: { type: 'string' } },
            additionalProperties: false,
          },
        },
      },
    }),
  );
  const files = [
    { name: 'workflow.mjs', bytes },
    { name: 'schemas/input.json', bytes: input },
    { name: 'schemas/output.json', bytes: output },
  ];
  const header = Buffer.from(
    JSON.stringify({
      manifest: CLEANUP_MANIFEST,
      files: files.map((file) => ({
        name: file.name,
        size: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex'),
      })),
    }),
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  const installed = await installWorkflowPackage(
    stateDirectory,
    Buffer.concat([length, header, ...files.map((file) => file.bytes)]),
  );
  await activateWorkflowPackage(stateDirectory, installed.manifest.id, installed.digest);
  return installed;
}
