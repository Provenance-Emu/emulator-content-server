import { DomainError } from '@ecs/domain';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { DavResource } from './handler.js';
import { davHref } from './paths.js';

interface Property {
  namespace: string;
  name: string;
}
interface Selection {
  mode: 'allprop' | 'propname' | 'prop';
  properties: Property[];
}
const bad = () => new DomainError('invalid-body', 400, 'Invalid DAV XML');
export function xmlEscape(value: string): string {
  return (
    Buffer.from(value, 'utf8')
      .toString('utf8')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject XML-invalid or unsafe path characters
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '\ufffd')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
  );
}
function elements(node: Element): Element[] {
  return Array.from(node.childNodes).filter((n): n is Element => n.nodeType === 1);
}
export function parsePropfind(body: string): Selection {
  if (Buffer.byteLength(body) > 32768)
    throw new DomainError('quota-exceeded', 413, 'DAV XML is too large');
  if (!body.trim()) return { mode: 'allprop', properties: [] };
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(body) || (body.match(/<[A-Za-z_]/g)?.length ?? 0) > 512)
    throw bad();
  try {
    const doc = new DOMParser({
      onError() {
        throw bad();
      },
    }).parseFromString(body, 'application/xml');
    const root = doc.documentElement;
    if (root?.namespaceURI !== 'DAV:' || root.localName !== 'propfind') throw bad();
    const stack = [{ node: root, depth: 1 }];
    while (stack.length) {
      const next = stack.pop();
      if (!next) break;
      if (next.depth > 16) throw bad();
      for (const child of elements(next.node)) stack.push({ node: child, depth: next.depth + 1 });
      for (const child of Array.from(next.node.childNodes)) {
        if ((child.nodeType === 3 || child.nodeType === 4) && child.textContent?.trim())
          throw bad();
      }
    }
    const choices = elements(root);
    const choice = choices[0];
    if (
      choices.length !== 1 ||
      !choice ||
      choice.namespaceURI !== 'DAV:' ||
      !['allprop', 'propname', 'prop'].includes(choice.localName ?? '')
    )
      throw bad();
    const mode = choice.localName as Selection['mode'];
    const requested = elements(choice);
    if (requested.length > 128 || (mode !== 'prop' && requested.length !== 0)) throw bad();
    const properties = requested.map((node) => {
      if (elements(node).length) throw bad();
      return { namespace: node.namespaceURI ?? '', name: node.localName ?? node.nodeName };
    });
    return { mode, properties };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw bad();
  }
}
function values(resource: DavResource): Record<string, string> {
  const result: Record<string, string> = {
    displayname: xmlEscape(resource.displayName),
    resourcetype: resource.kind === 'collection' ? '<d:collection/>' : '',
    getcontenttype:
      resource.kind === 'collection' ? 'httpd/unix-directory' : 'application/octet-stream',
  };
  if (resource.size !== undefined) result.getcontentlength = String(resource.size);
  if (resource.etag) result.getetag = xmlEscape(resource.etag);
  if (resource.createdAt) result.creationdate = xmlEscape(resource.createdAt);
  if (resource.modifiedAt) result.getlastmodified = new Date(resource.modifiedAt).toUTCString();
  return result;
}
export function multistatus(resources: DavResource[], selection: Selection): string {
  const responses = resources.map((resource) => {
    const available = values(resource);
    const wanted =
      selection.mode === 'prop'
        ? selection.properties
        : Object.keys(available).map((name) => ({ namespace: 'DAV:', name }));
    const good: string[] = [];
    const missing: string[] = [];
    for (const property of wanted) {
      const known = property.namespace === 'DAV:' && Object.hasOwn(available, property.name);
      const tag = property.namespace === 'DAV:' ? `d:${property.name}` : `x:${property.name}`;
      const ns = property.namespace === 'DAV:' ? '' : ` xmlns:x="${xmlEscape(property.namespace)}"`;
      // Unprefixed unknown properties have no namespace; no arbitrary client prefix is emitted.
      const actualTag = property.namespace === '' ? property.name : tag;
      const actualNs = property.namespace === '' ? ' xmlns=""' : ns;
      (known ? good : missing).push(
        selection.mode === 'propname' || !known
          ? `<${actualTag}${actualNs}/>`
          : `<${actualTag}${actualNs}>${available[property.name]}</${actualTag}>`,
      );
    }
    const group = (list: string[], status: string) =>
      list.length
        ? `<d:propstat><d:prop>${list.join('')}</d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat>`
        : '';
    return `<d:response><d:href>${xmlEscape(davHref(resource.segments, resource.kind === 'collection'))}</d:href>${group(good, '200 OK')}${group(missing, '404 Not Found')}</d:response>`;
  });
  return `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${responses.join('')}</d:multistatus>`;
}
