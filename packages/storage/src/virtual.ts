import {
  DomainError,
  type MaterializeQuota,
  type VirtualArtifactBundle,
  type VirtualContentProvider,
  type VirtualEntry,
  type VirtualResolution,
  type VirtualWindow,
} from '@ecs/domain';

export const DEFAULT_MATERIALIZE_QUOTA: MaterializeQuota = {
  maxExpandedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 100,
  maxEntries: 10_000,
  maxNesting: 2,
  timeoutMs: 60_000,
};

export class VirtualProviderRegistry {
  private readonly bundleJobs = new Set<Promise<unknown>>();
  private readonly shutdown = new AbortController();
  readonly signal: AbortSignal = this.shutdown.signal;
  constructor(
    private readonly providers: readonly VirtualContentProvider[] = [],
    readonly quota: MaterializeQuota = DEFAULT_MATERIALIZE_QUOTA,
  ) {}

  formats(): string[] {
    return this.providers.map((provider) => provider.format);
  }

  async inspect(
    filePath: string,
    window?: VirtualWindow,
  ): Promise<{ format: string; entries: VirtualEntry[] } | null> {
    if (this.signal.aborted)
      throw new DomainError('archive-rejected', 422, 'Virtual provider registry is closed');
    for (const provider of this.providers) {
      const found = await provider.inspect(filePath, this.quota, window);
      if (found) return { format: provider.format, entries: found.entries };
    }
    return null;
  }

  async resolve(
    filePath: string,
    entryId: string,
  ): Promise<{ format: string; resolution: VirtualResolution } | null> {
    if (this.signal.aborted)
      throw new DomainError('archive-rejected', 422, 'Virtual provider registry is closed');
    for (const provider of this.providers) {
      const found = await provider.resolve?.(filePath, entryId, this.quota);
      if (found) return { format: provider.format, resolution: found };
    }
    return null;
  }

  async materializeBundle(
    format: string,
    filePath: string,
    bundleId: string,
    destinationDirectory: string,
    signal?: AbortSignal,
  ): Promise<VirtualArtifactBundle> {
    const provider = this.providers.find((candidate) => candidate.format === format);
    if (!provider?.materializeBundle)
      throw new DomainError('unsupported-entry', 422, `Format ${format} cannot expand bundles`);
    return provider.materializeBundle(filePath, bundleId, destinationDirectory, this.quota, signal);
  }

  trackBundle<T>(operation: Promise<T>): Promise<T> {
    const owned = operation.finally(() => this.bundleJobs.delete(owned));
    this.bundleJobs.add(owned);
    return owned;
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    const [providers] = await Promise.all([
      Promise.allSettled(this.providers.map((provider) => provider.close?.())),
      Promise.allSettled([...this.bundleJobs]),
    ]);
    for (const result of providers) if (result.status === 'rejected') throw result.reason;
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
