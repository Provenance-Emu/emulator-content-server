import { createServer } from 'node:http';
import {
  type AltStoreSource,
  type LoadedPlugin,
  PluginError,
  renderAltStoreSource,
} from '@ecs/plugins';

export interface PublishedFeed {
  id: string;
  name: string;
  source: AltStoreSource;
}

export interface FeedReply {
  status: number;
  body: string;
}

/**
 * The feeds a plugin directory is willing to publish. Rendering happens before
 * any request, so a request cannot reach a certificate, a secret, or a wasm file.
 */
export function publishedFeeds(plugins: readonly LoadedPlugin[]): PublishedFeed[] {
  return plugins
    .flatMap((plugin) => {
      if (plugin.manifest.kind !== 'feed' || !plugin.manifest.feed) return [];
      return [
        {
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          source: renderAltStoreSource(plugin.manifest.name, plugin.manifest.feed),
        },
      ];
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * One AltStore document per plugin, plus an index. `sourceURL` is rewritten to
 * the URL that was just requested, because that is the URL a client will refresh.
 */
export function respondToFeed(
  feeds: readonly PublishedFeed[],
  method: string,
  requestPath: string,
  origin: string,
): FeedReply {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: '' };
  const path = pathname(requestPath);
  if (path === '/' || path === '/index.json') {
    return {
      status: 200,
      body: `${JSON.stringify({
        sources: feeds.map((feed) => ({
          name: feed.name,
          identifier: feed.source.identifier,
          sourceURL: `${origin}/${feed.id}.json`,
        })),
      })}\n`,
    };
  }
  const id = feedId(path);
  const feed = id === null ? undefined : feeds.find((item) => item.id === id);
  if (!feed) return { status: 404, body: '' };
  return {
    status: 200,
    body: `${JSON.stringify({ ...feed.source, sourceURL: `${origin}${path}` })}\n`,
  };
}

export async function serveFeeds(
  feeds: readonly PublishedFeed[],
  options: { host?: string; port?: number; allowLan?: boolean } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? '127.0.0.1';
  if (!options.allowLan && host !== '127.0.0.1' && host !== '::1') {
    throw new PluginError('listen', 'The feed server binds loopback unless --allow-lan is set');
  }
  const server = createServer((request, response) => {
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : (options.port ?? 0);
    const origin = `http://${host === '::1' ? '[::1]' : host}:${port}`;
    const reply = respondToFeed(feeds, request.method ?? 'GET', request.url ?? '/', origin);
    response.writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : reply.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new PluginError('listen', 'The feed server did not bind a port');
  }
  const url = `http://${host === '::1' ? '[::1]' : host}:${address.port}`;
  return {
    url,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function pathname(requestPath: string): string {
  try {
    return new URL(requestPath, 'http://feeds.local').pathname;
  } catch {
    return '/';
  }
}

/** A plugin id plus `.json`. Anything else, including a secret file, is not a feed. */
function feedId(path: string): string | null {
  const match = /^\/([a-z0-9]+(?:\.[a-z0-9-]+)+)\.json$/.exec(path);
  return match?.[1] ?? null;
}
