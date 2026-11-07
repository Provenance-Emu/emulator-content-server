import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendedEmulators } from '../src/lib/emulator-recommendations.js';
import { playerManagementFixture, playerProfile } from './player-management-fixture.js';

function entry(id: string, systems: string[], available = true) {
  return {
    id,
    name: id,
    systems,
    available,
    reason: null,
    downloadBytes: 1024,
    description: 'Generated fixture',
  };
}

test('recommendations prefer curated cores, deduplicate system coverage and ignore unavailable entries', () => {
  const listing = playerManagementFixture();
  listing.items = [];
  listing.available = [
    entry('org.libretro.quicknes', ['nes']),
    entry('org.libretro.nestopia', ['nes', 'fds']),
    entry('org.libretro.genesis-plus-gx', ['genesis', 'mastersystem']),
    entry('org.libretro.gearsystem', ['mastersystem']),
    entry('org.libretro.snes9x', ['snes'], false),
    entry('org.libretro.snes9x2010', ['snes']),
  ];
  assert.deepEqual(
    recommendedEmulators(listing).map((item) => item.id),
    ['org.libretro.nestopia', 'org.libretro.genesis-plus-gx', 'org.libretro.snes9x2010'],
  );
  assert.deepEqual(
    recommendedEmulators({ ...listing, available: [...listing.available].reverse() }),
    recommendedEmulators(listing),
  );
});

test('recommendations preserve existing enabled coverage and default choices without enabling disabled installs', () => {
  const listing = playerManagementFixture();
  listing.available = [
    entry('org.libretro.nestopia', ['com.provenance.nes']),
    entry('org.libretro.mgba', ['com.provenance.gba']),
    entry('org.libretro.gambatte', ['com.provenance.gb', 'com.provenance.gbc']),
  ];
  listing.items.push({
    profile: playerProfile('org.libretro.mgba'),
    enabled: false,
    source: 'managed',
    removable: true,
  });
  assert.deepEqual(
    recommendedEmulators(listing).map((item) => item.id),
    ['org.libretro.gambatte'],
  );
  assert.equal(listing.defaultProfileId, 'managed');
  assert.equal(listing.items.at(-1)?.enabled, false);
});
