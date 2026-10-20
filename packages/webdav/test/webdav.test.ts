import assert from 'node:assert/strict';
import test from 'node:test';
import { type DavNamespace, type DavResource, handleDav, parseDavPath } from '../src/index.js';

const root: DavResource = { segments: [], displayName: 'Library & <catalog>', kind: 'collection' };
const file: DavResource = {
  segments: ['ü & x.bin'],
  displayName: 'ü & x.bin',
  kind: 'asset',
  id: 'a',
  size: 16,
  etag: '"digest"',
  modifiedAt: '2026-01-01T00:00:00.000Z',
};
const namespace: DavNamespace = {
  async resolve(parts) {
    return parts.length === 0 ? root : parts[0] === file.segments[0] ? file : null;
  },
  async children() {
    return [file];
  },
};
const xml = (body: string) => `<d:propfind xmlns:d="DAV:">${body}</d:propfind>`;
test('PROPFIND lists finite depths, escapes XML/hrefs, and supplies file properties', async () => {
  const zero = await handleDav({ method: 'PROPFIND', url: '/dav/', depth: '0' }, namespace);
  assert.equal(zero.status, 207);
  assert.equal((zero.body?.match(/<d:response>/g) ?? []).length, 1);
  const one = await handleDav({ method: 'PROPFIND', url: '/dav/', depth: '1' }, namespace);
  assert.equal((one.body?.match(/<d:response>/g) ?? []).length, 2);
  assert.match(one.body ?? '', /Library &amp; &lt;catalog&gt;/);
  assert.match(one.body ?? '', /%C3%BC%20%26%20x.bin/);
  assert.match(one.body ?? '', /<d:getcontentlength>16<\/d:getcontentlength>/);
  assert.match(one.body ?? '', /Thu, 01 Jan 2026 00:00:00 GMT/);
  for (const depth of [undefined, 'infinity']) {
    const response = await handleDav({ method: 'PROPFIND', url: '/dav/', depth }, namespace);
    assert.equal(response.status, 403);
    assert.match(response.body ?? '', /propfind-finite-depth/);
  }
  await assert.rejects(handleDav({ method: 'PROPFIND', url: '/dav/', depth: '2' }, namespace), {
    status: 400,
  });
});
test('property selection separates unknown namespaces and propname emits names only', async () => {
  const explicit = await handleDav(
    {
      method: 'PROPFIND',
      url: '/dav/',
      depth: '0',
      body: xml('<d:prop><d:displayname/><q:displayname xmlns:q="urn:unknown"/></d:prop>'),
    },
    namespace,
  );
  assert.match(explicit.body ?? '', /HTTP\/1.1 200 OK/);
  assert.match(explicit.body ?? '', /HTTP\/1.1 404 Not Found/);
  assert.match(explicit.body ?? '', /urn:unknown/);
  const names = await handleDav(
    { method: 'PROPFIND', url: '/dav/', depth: '0', body: xml('<d:propname/>') },
    namespace,
  );
  assert.match(names.body ?? '', /<d:displayname\/>/);
  assert.doesNotMatch(names.body ?? '', /Library/);
});
test('XML limits, malformed structures and entity declarations are refused', async () => {
  for (const body of [
    '<broken>',
    '<propfind/>',
    xml('<d:allprop/><d:propname/>'),
    '<!DOCTYPE a [<!ENTITY x "boom">]><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>',
    xml('<d:prop><d:a><d:b/></d:a></d:prop>'),
    xml(`<d:prop>${'<d:x/>'.repeat(129)}</d:prop>`),
    xml('<x>'.repeat(17) + '</x>'.repeat(17)),
  ]) {
    await assert.rejects(
      handleDav({ method: 'PROPFIND', url: '/dav/', depth: '0', body }, namespace),
      { status: 400 },
    );
  }
  await assert.rejects(
    handleDav({ method: 'PROPFIND', url: '/dav/', depth: '0', body: ' '.repeat(32769) }, namespace),
    { status: 413 },
  );
  await assert.rejects(
    handleDav(
      { method: 'PROPFIND', url: '/dav/', depth: '1' },
      {
        ...namespace,
        async children() {
          return Array.from({ length: 10001 }, () => file);
        },
      },
    ),
    { status: 507 },
  );
});
test('virtual URL parsing refuses traversal and accepts normalized Unicode and query strings', () => {
  for (const path of [
    '/dav/../secret',
    '/dav/%2e%2e/secret',
    '/dav/%252e%252e',
    '/dav/x%2fy',
    '/dav/x%5cy',
    '/dav/x\\y',
    '/dav/%00',
    '/dav/%zz',
    '/dav/C:/secret',
    '/dav//secret',
    'https://host/dav/',
  ])
    assert.throws(() => parseDavPath(path));
  assert.deepEqual(parseDavPath('/dav/u%CC%88.bin?ignored=yes'), ['ü.bin']);
});
test('read-only methods never mutate namespace, OPTIONS advertises only implemented methods', async () => {
  for (const method of ['PUT', 'DELETE', 'COPY', 'MOVE', 'MKCOL', 'PROPPATCH', 'LOCK', 'UNLOCK']) {
    assert.equal((await handleDav({ method, url: '/dav/' }, namespace)).status, 405);
  }
  const options = await handleDav({ method: 'OPTIONS', url: '/dav/' }, namespace);
  assert.equal(options.headers.dav, '1');
  assert.doesNotMatch(options.headers.allow ?? '', /PUT|LOCK/);
  assert.equal((await handleDav({ method: 'GET', url: '/dav/' }, namespace)).status, 405);
  assert.equal(
    (await handleDav({ method: 'HEAD', url: '/dav/%C3%BC%20%26%20x.bin' }, namespace)).file?.id,
    'a',
  );
});
