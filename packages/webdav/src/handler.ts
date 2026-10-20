import { DomainError } from '@ecs/domain';
import { parseDavPath } from './paths.js';
import { multistatus, parsePropfind } from './properties.js';
export interface DavResource {
  segments: string[];
  displayName: string;
  kind: 'collection' | 'asset' | 'source';
  id?: string;
  size?: number;
  etag?: string;
  createdAt?: string;
  modifiedAt?: string;
}
export interface DavNamespace {
  resolve(segments: string[]): Promise<DavResource | null>;
  children(resource: DavResource): Promise<DavResource[]>;
}
export interface DavResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
  file?: DavResource;
}
export async function handleDav(
  input: { method: string; url: string; depth?: string; body?: string },
  namespace: DavNamespace,
): Promise<DavResponse> {
  const headers = { dav: '1', allow: 'OPTIONS, PROPFIND, GET, HEAD' };
  const segments = parseDavPath(input.url);
  if (!['OPTIONS', 'PROPFIND', 'GET', 'HEAD'].includes(input.method))
    return { status: 405, headers };
  const resource = await namespace.resolve(segments);
  if (!resource) throw new DomainError('not-found', 404, 'Resource not found');
  if (input.method === 'OPTIONS') return { status: 200, headers };
  if (input.method === 'GET' || input.method === 'HEAD')
    return resource.kind === 'collection'
      ? { status: 405, headers }
      : { status: 200, headers, file: resource };
  if (input.depth === undefined || input.depth === 'infinity')
    return {
      status: 403,
      headers: { ...headers, 'content-type': 'application/xml; charset=utf-8' },
      body: '<d:error xmlns:d="DAV:"><d:propfind-finite-depth/></d:error>',
    };
  if (input.depth !== '0' && input.depth !== '1')
    throw new DomainError('invalid-body', 400, 'Invalid Depth');
  const selection = parsePropfind(input.body ?? '');
  const children =
    input.depth === '1' && resource.kind === 'collection' ? await namespace.children(resource) : [];
  if (children.length > 10_000)
    throw new DomainError('quota-exceeded', 507, 'Collection is too large');
  return {
    status: 207,
    headers: { ...headers, 'content-type': 'application/xml; charset=utf-8' },
    body: multistatus([resource, ...children], selection),
  };
}
