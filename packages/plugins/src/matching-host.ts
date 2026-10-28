import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ProviderCapability } from './manifest.js';
import { PROVIDER_CAPABILITIES } from './manifest.js';
import type { MatchingInput, MatchingResult } from './matching.js';
import { validateCandidates } from './matching.js';
export interface MatchingJob {
  operation: 'list' | 'match' | 'artwork' | 'cheats';
  artworkUrl?: string;
  catalogCacheDirectory?: string;
  directory?: string;
  managerId?: string;
  providerIds?: string[];
  input?: MatchingInput;
}
export interface MatchingPluginDescription {
  id: string;
  name: string;
  kind: 'provider' | 'manager';
  capabilities: ProviderCapability[];
  network: boolean;
}
export interface MatchingReply {
  plugins: MatchingPluginDescription[];
  result?: MatchingResult;
  artwork?: string;
  file?: string;
}

/** Process isolation for trusted, operator-installed JavaScript; this is not an OS sandbox. */
export async function matchingJob(
  job: MatchingJob,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<MatchingReply> {
  options.signal?.throwIfAborted();
  if (Buffer.byteLength(JSON.stringify(job)) > 512 * 1024)
    throw new Error('Matching input too large');
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./matching-worker.js', import.meta.url)), [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      // Do not forward server credentials, bootstrap state, or Node injection flags.
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), LANG: 'en_US.UTF-8' },
      execArgv: ['--max-old-space-size=192'],
    });
    let settled = false;
    const finish = (error?: Error, value?: MatchingReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      child.kill('SIGKILL');
      if (error) reject(error);
      else if (value) resolve(value);
      else reject(new Error('Matching host returned no data'));
    };
    const aborted = () => finish(new Error('Matching cancelled'));
    const timer = setTimeout(
      () => finish(new Error('Matching timed out')),
      options.timeoutMs ?? 25_000,
    );
    options.signal?.addEventListener('abort', aborted, { once: true });
    child.once('error', () => finish(new Error('Matching host unavailable')));
    child.once('exit', () => finish(new Error('Matching host stopped')));
    child.once('message', (raw: unknown) => {
      try {
        if (
          Buffer.byteLength(JSON.stringify(raw)) >
          (job.operation === 'artwork' ? 3 * 1024 * 1024 : 512 * 1024)
        )
          throw new Error('Response too large');
        const reply = raw as MatchingReply;
        if (!reply || !Array.isArray(reply.plugins) || reply.plugins.length > 64)
          throw new Error('Invalid host response');
        for (const plugin of reply.plugins) {
          if (
            !plugin ||
            !/^[a-z0-9]+(?:\.[a-z0-9-]+)+$/.test(plugin.id) ||
            typeof plugin.name !== 'string' ||
            plugin.name.length > 80 ||
            !['provider', 'manager'].includes(plugin.kind) ||
            !Array.isArray(plugin.capabilities) ||
            plugin.capabilities.some((c) => !PROVIDER_CAPABILITIES.includes(c)) ||
            typeof plugin.network !== 'boolean'
          )
            throw new Error('Invalid plugin');
        }
        if (
          job.operation === 'artwork' &&
          (typeof reply.artwork !== 'string' ||
            reply.artwork.length > Math.ceil((2 * 1024 * 1024) / 3) * 4 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.artwork))
        )
          throw new Error('Invalid artwork');
        if (
          job.operation === 'cheats' &&
          (typeof reply.file !== 'string' ||
            reply.file.length > 350000 ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.file))
        )
          throw new Error('Invalid cheat file');
        if (job.operation === 'match') {
          if (
            !reply.result ||
            !Array.isArray(reply.result.candidates) ||
            reply.result.candidates.length > 100 ||
            !Array.isArray(reply.result.problems) ||
            reply.result.problems.length > 32
          )
            throw new Error('Invalid matching result');
          reply.result.candidates = reply.result.candidates.map((c) => {
            const provider = reply.plugins.find(
              (p) => p.id === c.providerId && p.kind === 'provider',
            );
            if (!provider || (provider.network && !job.input?.online))
              throw new Error('Invalid provider');
            const candidate = validateCandidates([c], provider.capabilities)[0];
            if (!candidate) throw new Error('Invalid candidate');
            return {
              ...candidate,
              providerId: provider.id,
            };
          });
          for (const problem of reply.result.problems)
            if (
              problem.code !== 'provider-failed' ||
              !reply.plugins.some((p) => p.id === problem.providerId)
            )
              throw new Error('Invalid problem');
        }
        finish(undefined, reply);
      } catch {
        finish(new Error('Matching host returned invalid data'));
      }
    });
    child.send(job, (error) => {
      if (error) finish(new Error('Matching host unavailable'));
    });
  });
}
