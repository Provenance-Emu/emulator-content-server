import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopUpdate } from '../src/lib/desktop-updates.js';

test('desktop notices require a newer installer for the current platform and exact build metadata', () => {
  const name = 'Emulation-Server-nightly-macos-arm64.dmg';
  const installed = { sha: 'a'.repeat(40), builtAt: '2026-11-11T00:00:00Z' };
  const publishedAt = '2026-11-12T00:00:00Z';
  const sha = 'b'.repeat(40);
  const asset = { name, label: `Notarized app [build ${sha}]`, created_at: publishedAt };
  assert.deepEqual(desktopUpdate([asset], installed, name), { sha, publishedAt });
  assert.equal(desktopUpdate([{ ...asset, label: 'Retained app' }], installed, name), undefined);
  assert.equal(
    desktopUpdate([{ ...asset, label: `App [build ${installed.sha}]` }], installed, name),
    undefined,
  );
  assert.equal(
    desktopUpdate([{ ...asset, created_at: '2026-11-10T00:00:00Z' }], installed, name),
    undefined,
  );
  assert.equal(
    desktopUpdate([asset], installed, 'Emulation-Server-nightly-windows-x64.msi'),
    undefined,
  );
});
