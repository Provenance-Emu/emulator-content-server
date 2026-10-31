import { createHash } from 'node:crypto';
import { safeRelativePath } from '../paths.js';
import { parseWorkflowManifest, type WorkflowManifestV2 } from './manifest.js';
import { validateSchemaDocument } from './schemas.js';
import { integer, invalid, jsonValue, list, object, text } from './values.js';

export const WORKFLOW_PACKAGE_LIMITS = Object.freeze({
  bytes: 128 * 1024 * 1024,
  header: 4 * 1024 * 1024,
  files: 4096,
  fileBytes: 16 * 1024 * 1024,
});
export interface WorkflowPackage {
  manifest: WorkflowManifestV2;
  files: Map<string, Buffer>;
  digest: string;
}

/** Exact length-prefixed bytes; there is no decompression, link creation or module import. */
export function parseWorkflowPackage(bytes: Uint8Array): WorkflowPackage {
  integer(bytes.byteLength, 4, WORKFLOW_PACKAGE_LIMITS.bytes);
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = integer(buffer.readUInt32BE(0), 1, WORKFLOW_PACKAGE_LIMITS.header);
  if (4 + headerLength > buffer.length) invalid('Incomplete workflow package');
  let header: Record<string, unknown>;
  try {
    header = object(
      JSON.parse(
        new TextDecoder('utf8', { fatal: true }).decode(buffer.subarray(4, 4 + headerLength)),
      ),
      ['manifest', 'files'],
    );
  } catch {
    return invalid('Invalid workflow package header');
  }
  jsonValue(header, WORKFLOW_PACKAGE_LIMITS.header, true);
  const manifest = parseWorkflowManifest(header.manifest);
  const files = new Map<string, Buffer>();
  const canonical = new Set<string>();
  let offset = headerLength + 4;
  for (const raw of list(header.files, WORKFLOW_PACKAGE_LIMITS.files)) {
    const item = object(raw, ['name', 'size', 'sha256']);
    const name = text(item.name, 1024);
    if (name.includes('\\') || safeRelativePath(name) !== name)
      invalid('Invalid workflow package path');
    if (
      name
        .split('/')
        .some(
          (part) =>
            /[<>:"|?*]/.test(part) ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
            Array.from(part).some((character) => character.charCodeAt(0) < 32),
        )
    )
      invalid('Workflow package path is not portable');
    const key = name.normalize('NFC').toLowerCase();
    if (key === 'plugin.json' || key.startsWith('plugin.json/') || canonical.has(key))
      invalid('Duplicate or reserved package file');
    for (const existing of canonical)
      if (existing.startsWith(`${key}/`) || key.startsWith(`${existing}/`))
        invalid('Package file collides with a directory');
    canonical.add(key);
    const size = integer(item.size, 0, WORKFLOW_PACKAGE_LIMITS.fileBytes);
    const digest = text(item.sha256, 64);
    if (!/^[a-f0-9]{64}$/.test(digest) || offset + size > buffer.length)
      invalid('Invalid workflow resource');
    const content = buffer.subarray(offset, offset + size);
    if (createHash('sha256').update(content).digest('hex') !== digest)
      invalid('Workflow resource digest mismatch');
    files.set(name, content);
    offset += size;
  }
  if (offset !== buffer.length || !files.has(manifest.entry))
    invalid('Incomplete workflow package resources');
  for (const path of [manifest.configurationSchema, manifest.inputSchema, manifest.outputSchema]) {
    if (!path) continue;
    const content = files.get(path);
    if (!content) invalid('Missing workflow schema resource');
    validateSchemaDocument(JSON.parse(content.toString('utf8')));
  }
  return { manifest, files, digest: createHash('sha256').update(buffer).digest('hex') };
}
