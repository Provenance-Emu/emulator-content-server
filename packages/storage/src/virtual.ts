import {
  DomainError,
  type MaterializeQuota,
  type VirtualContentProvider,
  type VirtualEntry,
  type VirtualEntryLocation,
} from '@ecs/domain';

export const DEFAULT_MATERIALIZE_QUOTA: MaterializeQuota = {
  maxExpandedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 10_000,
  maxNesting: 1,
  timeoutMs: 60_000,
};

export class VirtualProviderRegistry {
  constructor(
    private readonly providers: readonly VirtualContentProvider[] = [],
    private readonly quota: MaterializeQuota = DEFAULT_MATERIALIZE_QUOTA,
  ) {}

  formats(): string[] {
    return this.providers.map((provider) => provider.format);
  }

  async inspect(filePath: string): Promise<{ format: string; entries: VirtualEntry[] } | null> {
    for (const provider of this.providers) {
      const found = await provider.inspect(filePath, this.quota);
      if (found) return { format: provider.format, entries: found.entries };
    }
    return null;
  }

  async locate(
    filePath: string,
    entryId: string,
  ): Promise<(VirtualEntryLocation & { format: string }) | null> {
    for (const provider of this.providers) {
      const found = await provider.locate?.(filePath, entryId, this.quota);
      if (found) return { ...found, format: provider.format };
    }
    return null;
  }

  async materialize(
    format: string,
    filePath: string,
    entryId: string,
    destination: string,
  ): Promise<{ sha256: string; size: number }> {
    const provider = this.providers.find((candidate) => candidate.format === format);
    if (!provider?.materialize) {
      throw new DomainError('unsupported-entry', 422, `Format ${format} cannot expand entries`);
    }
    return provider.materialize(filePath, entryId, destination, this.quota);
  }
}
