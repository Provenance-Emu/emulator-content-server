import { LIBRETRO_SYSTEMS } from './libretro-matching.js';
import type { MatchCandidate, MatchingProvider } from './matching.js';

export function cheatStem(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/\s+\((?:Game Genie|Action Replay|Pro Action Replay|GameShark|CodeBreaker)\)$/i, '')
    .normalize('NFC')
    .toLowerCase();
}
/** Preserve code syntax while forcing every entry off; never execute or apply a cheat. */
export function normalizeCheats(bytes: Uint8Array): { count: number; text: string } {
  if (bytes.byteLength > 256 * 1024) throw new Error('Cheat file too large');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (Array.from(text).some((c) => c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))))
    throw new Error('Invalid cheat text');
  const fields = new Map<string, string>();
  const lines = text.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith('#')) return line;
    const match =
      /^\s*(cheats|cheat\d+_[a-z0-9_]+)\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^#"\r\n]*?))\s*(?:#.*)?$/i.exec(
        line,
      );
    if (!match?.[1] || fields.has(match[1].toLowerCase())) throw new Error('Invalid cheat fields');
    const key = match[1].toLowerCase();
    fields.set(key, (match[2] ?? match[3] ?? '').trim());
    return /^cheat\d+_enable$/.test(key) ? `${key} = "false"` : line;
  });
  const countText = fields.get('cheats') ?? '';
  const count = Number(countText);
  if (!/^\d+$/.test(countText) || !Number.isSafeInteger(count) || count < 1 || count > 1000)
    throw new Error('Invalid cheat count');
  for (const key of fields.keys()) {
    const index = /^cheat(\d+)_/.exec(key)?.[1];
    if (index !== undefined && Number(index) >= count) throw new Error('Invalid cheat index');
  }
  for (let index = 0; index < count; index++) {
    if (!fields.has(`cheat${index}_code`) && !fields.has(`cheat${index}_address`))
      throw new Error('Missing cheat code');
    if (!fields.has(`cheat${index}_enable`)) lines.push(`cheat${index}_enable = "false"`);
  }
  const normalized = lines.join('\n').trimEnd() + '\n';
  if (Buffer.byteLength(normalized) > 256 * 1024) throw new Error('Cheat file too large');
  return { count, text: normalized };
}
export const localCheatsProvider: MatchingProvider = {
  id: 'org.ecs.cheats.local',
  name: 'Local cheat files',
  capabilities: ['cheats'],
  network: false,
  async search(input) {
    return input.companions
      .filter((file) => file.cheats && cheatStem(file.name) === cheatStem(input.name))
      .map((file) => ({
        id: file.id,
        kind: 'cheats',
        title: file.name.replace(/\.cht$/i, ''),
        confidence: 'name',
        fileId: file.id,
        metadata: {
          format: 'retroarch-cht',
          count: String(file.cheats?.count),
          verification: 'Filename and system association; verify region and version',
        },
      }));
  },
};
async function publicJson(
  url: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    redirect: 'error',
    headers: { accept: 'application/vnd.github+json' },
    ...(signal ? { signal } : {}),
  });
  if (response.status === 404) return null;
  if (!response.ok || !response.body) throw new Error('Cheat index unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 2 * 1024 * 1024) throw new Error('Cheat index too large');
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}
export function createLibretroCheatsProvider(fetcher: typeof fetch = fetch): MatchingProvider {
  const cache = new Map<string, string[]>();
  return {
    id: 'org.ecs.cheats.libretro',
    name: 'Libretro cheat database',
    capabilities: ['cheats'],
    network: true,
    async search(input, signal) {
      const system = input.systemId ? LIBRETRO_SYSTEMS[input.systemId] : undefined;
      if (!system) return [];
      let files = cache.get(system.platform);
      if (!files) {
        const directories = await publicJson(
          'https://api.github.com/repos/libretro/libretro-database/contents/cht',
          fetcher,
          signal,
        );
        if (!Array.isArray(directories)) throw new Error('Invalid cheat index');
        const directory = directories.find(
          (entry) => entry && entry.name === system.platform && entry.type === 'dir',
        );
        if (!directory) return [];
        if (typeof directory.sha !== 'string' || !/^[0-9a-f]{40}$/.test(directory.sha))
          throw new Error('Invalid cheat directory');
        const tree = (await publicJson(
          `https://api.github.com/repos/libretro/libretro-database/git/trees/${directory.sha}`,
          fetcher,
          signal,
        )) as { truncated?: boolean; tree?: unknown[] } | null;
        if (!tree || tree.truncated || !Array.isArray(tree.tree))
          throw new Error('Incomplete cheat index');
        files = tree.tree.flatMap((value) => {
          const entry = value as { type?: string; path?: string };
          return entry?.type === 'blob' &&
            typeof entry.path === 'string' &&
            !/[/\\\0]/.test(entry.path) &&
            entry.path.length <= 512 &&
            /\.cht$/i.test(entry.path)
            ? [entry.path]
            : [];
        });
        cache.set(system.platform, files);
      }
      return files
        .filter((file) => cheatStem(file) === cheatStem(input.name))
        .slice(0, 20)
        .map(
          (file, index): MatchCandidate => ({
            id: `cheats-${index}`,
            kind: 'cheats',
            title: file.replace(/\.cht$/i, ''),
            confidence: 'name',
            url: `https://raw.githubusercontent.com/libretro/libretro-database/master/cht/${encodeURIComponent(system.platform)}/${encodeURIComponent(file)}`,
            metadata: {
              source: 'Libretro cheat database',
              format: 'retroarch-cht',
              verification: 'Filename and system only; verify region and version',
            },
          }),
        );
    },
  };
}
