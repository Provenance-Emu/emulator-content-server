import type { TestContext } from 'node:test';
import { ContentClient, type ContentRoot, type Library } from '@ecs/client';

export function folderFixture(t: TestContext) {
  const original = globalThis.fetch;
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const libraries: Library[] = [
    {
      id: 'library',
      name: 'Arcade',
      ownerId: 'owner',
      revision: 1,
      createdAt: '2026-10-20T00:00:00Z',
    },
  ];
  const roots: ContentRoot[] = [];
  let override: ((path: string, body: Record<string, unknown>) => Promise<Response | null>) | null =
    null;
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const method = init?.method ?? 'GET';
    calls.push({ method, path, body });
    const replaced = await override?.(path, body);
    if (replaced) return replaced;
    let result: unknown = {};
    if (path.endsWith('/browse-libraries')) result = { items: libraries, nextCursor: null };
    else if (path.endsWith('/libraries') && method === 'POST') {
      const library = {
        ownerId: 'owner',
        revision: 1,
        createdAt: '2026-10-20T00:00:00Z',
        id: `created-${libraries.length}`,
        name: String(body.name),
      };
      libraries.push(library);
      result = library;
    } else if (path.endsWith('/roots') && method === 'POST') {
      const root = {
        id: `root-${roots.length}`,
        path: String(body.path),
        label: String(body.label),
        libraryId: String(body.libraryId),
        createdAt: '2026-10-20T00:00:00Z',
      };
      roots.push(root);
      result = root;
    } else if (path.endsWith('/root-summaries')) {
      const query = new URL(String(input)).searchParams;
      result = {
        items: roots
          .filter((root) =>
            query.has('libraryId')
              ? root.libraryId === query.get('libraryId')
              : query.has('unassigned')
                ? root.libraryId === null
                : true,
          )
          .map((root) => ({
            root,
            indexedFileCount: 0,
            scanState: 'never',
            lastScanAt: null,
            lastCheckAt: null,
            online: null,
            medium: null,
          })),
      };
    } else if (path.endsWith('/library') && method === 'PUT') {
      const root = roots.find((root) => root.id === path.split('/').at(-2));
      if (!root) return Response.json({ title: 'Missing root' }, { status: 404 });
      if (root.libraryId !== null && root.libraryId !== body.libraryId)
        return Response.json({ title: 'Already assigned' }, { status: 409 });
      root.libraryId = String(body.libraryId);
      result = root;
    } else if (path.endsWith('/scan'))
      result = { rootId: path.split('/').at(-2), medium: 'disk', online: true, count: 0 };
    return Response.json(result);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return {
    client: new ContentClient('http://server.test'),
    calls,
    roots,
    libraries,
    context: { key: 'epoch', origin: 'http://server.test' },
    override(value: typeof override) {
      override = value;
    },
  };
}
export const selection = (path = '/server/Games') => ({
  path,
  suggestedName: '',
  contextKey: 'epoch',
  origin: 'http://server.test',
});
