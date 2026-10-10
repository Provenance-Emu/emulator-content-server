import type { MaterializeQuota, VirtualContentProvider, VirtualEntry } from '@ecs/domain';

export const DEFAULT_MATERIALIZE_QUOTA: MaterializeQuota = {
  maxExpandedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 10_000,
  maxNesting: 1,
  timeoutMs: 60_000,
};

export class VirtualProviderRegistry {
  constructor(private readonly providers: readonly VirtualContentProvider[] = []) {}

  formats(): string[] {
    return this.providers.map((provider) => provider.format);
  }

  async inspect(filePath: string): Promise<{ format: string; entries: VirtualEntry[] } | null> {
    for (const provider of this.providers) {
      const found = await provider.inspect(filePath);
      if (found) return { format: provider.format, entries: found.entries };
    }
    return null;
  }
}
