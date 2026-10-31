import type { BrowserCore } from './runtime.js';

/** Initial reviewed pthread build. A generic worker permission is never inferred from a manifest. */
export const dolphinBuild = {
  id: 'org.dolphin.wasm',
  loader: '0bfc73fbbf370d831fbce04239f062a93f885c053a86866ce5dca3a879be331f',
  wasm: 'd7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c',
} as const;

export function approvedDolphinBuild(core: BrowserCore): boolean {
  return (
    'profileVersion' in core &&
    core.id === dolphinBuild.id &&
    core.runtime === 'dolphin-wasm-esm' &&
    core.threaded === true &&
    core.saveCompletion === 'none' &&
    core.assets.length === 0 &&
    core.loader.sha256 === dolphinBuild.loader &&
    core.wasm.sha256 === dolphinBuild.wasm
  );
}

export interface IsolationSession {
  id: string;
  url: string;
  expiresAt: string;
}
export interface IsolationBroker {
  create(profileId: string): Promise<IsolationSession>;
  close(id: string): Promise<void>;
}

/** A same-origin iframe must never gain allow-same-origin through a malformed broker reply. */
export function isolatedPlayerUrl(session: IsolationSession, parentOrigin: string): URL {
  const url = new URL(session.url);
  const parent = new URL(parentOrigin);
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.port === parent.port ||
    url.origin === parent.origin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    typeof session.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{16,128}$/.test(session.id) ||
    !Number.isFinite(Date.parse(session.expiresAt)) ||
    Date.parse(session.expiresAt) <= Date.now()
  )
    throw new Error('The isolated emulator host is invalid or expired');
  return url;
}
