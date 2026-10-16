import type { CloudSecrets } from './cloud.js';
import { HTTP_SCHEMES, MOUNT_SCHEMES, type PluginManifest } from './manifest.js';

export interface Diagnosis {
  id: string;
  kind: string;
  ready: boolean;
  lines: string[];
}

export interface DiagnosisInput {
  secrets?: CloudSecrets | null;
  rootExists?: boolean;
  moduleExists?: boolean;
  certificateExists?: boolean;
  profileExists?: boolean;
  toolExists?: (name: string) => boolean;
}

/** Names the missing piece. Secret values are never copied into a line. */
export function diagnose(manifest: PluginManifest, input: DiagnosisInput = {}): Diagnosis {
  const lines: string[] = [];
  if (manifest.kind === 'connector' && manifest.connector) {
    lines.push(...connectorLines(manifest, input));
  }
  if (manifest.kind === 'player') {
    lines.push(
      input.moduleExists
        ? 'wasm module is present and will not be compiled by this host'
        : 'wasm module is absent',
    );
  }
  if (manifest.kind === 'feed') {
    const count = manifest.feed?.apps.length ?? 0;
    lines.push(`publishes ${count} app${count === 1 ? '' : 's'}: ${manifest.apps.join(', ')}`);
  }
  if (manifest.kind === 'signer' && manifest.signer) {
    lines.push(...fileLines(input.certificateExists, 'certificate'));
    lines.push(...fileLines(input.profileExists, 'profile'));
    lines.push(...toolLines(input.toolExists, manifest.signer.tool));
    lines.push('signing is planned only; zsign is not run and no password is accepted');
  }
  if (manifest.kind === 'jit' && manifest.jit) {
    lines.push(...toolLines(input.toolExists, manifest.jit.tool));
    lines.push(`activates only ${manifest.apps.join(', ')}`);
    lines.push('JIT is planned only; nothing is attached');
  }
  const ready = lines.every((line) => !needsAttention(line));
  return { id: manifest.id, kind: manifest.kind, ready, lines };
}

function needsAttention(line: string): boolean {
  return (
    line.startsWith('missing ') ||
    line.endsWith(' is absent') ||
    line.includes(' is not available') ||
    line.includes('was not checked')
  );
}

function connectorLines(manifest: PluginManifest, input: DiagnosisInput): string[] {
  const connector = manifest.connector;
  if (!connector) return ['missing connector'];
  const lines = [schemeLine(connector.scheme)];
  if (MOUNT_SCHEMES.has(connector.scheme)) {
    lines.push(input.rootExists ? 'mount is present' : 'mount is not available');
  }
  if (HTTP_SCHEMES.has(connector.scheme)) {
    const missing =
      connector.scheme === 's3'
        ? missingFields(input.secrets, ['accessKeyId', 'secretAccessKey'])
        : missingFields(input.secrets, ['accessToken']);
    lines.push(missing.length === 0 ? 'credentials are set' : `missing ${missing.join(', ')}`);
  }
  if (connector.scheme === 'custom') {
    lines.push(input.moduleExists ? 'entry module is present' : 'entry module is absent');
  }
  return lines;
}

function schemeLine(scheme: string): string {
  if (scheme === 'icloud') {
    return 'iCloud Drive is read through the folder the operating system has mounted';
  }
  if (scheme === 'nfs' || scheme === 'smb' || scheme === 'afp') {
    return `${scheme} is read through its mount; a plugin entry can speak the protocol instead`;
  }
  if (scheme === 'local') return 'local folder';
  if (scheme === 's3') return 'S3 requests are signed; set endpoint for an S3-compatible NAS';
  if (scheme === 'dropbox') return 'Dropbox is limited to the configured folder';
  if (scheme === 'googledrive') return 'Google Drive lists the configured folder and its children';
  if (scheme === 'box') return 'Box lists the configured folder and its children';
  return 'custom connector';
}

function missingFields(
  secrets: CloudSecrets | null | undefined,
  fields: readonly string[],
): string[] {
  if (!secrets) return [...fields];
  return fields.filter((field) => {
    const value = secrets[field as keyof CloudSecrets];
    return value === undefined || value.length === 0;
  });
}

function fileLines(exists: boolean | undefined, label: string): string[] {
  if (exists) return [`${label} is present`];
  return [`${label} is absent`];
}

function toolLines(lookup: ((name: string) => boolean) | undefined, tool: string): string[] {
  if (!lookup) return [`${tool} was not checked`];
  return [lookup(tool) ? `${tool} is on PATH` : `missing ${tool}`];
}
