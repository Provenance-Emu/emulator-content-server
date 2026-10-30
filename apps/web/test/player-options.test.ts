import assert from 'node:assert/strict';
import test from 'node:test';
import { coreOptionsConfig, parseOptions } from '../src/player/options.js';

test('option details preserve space-containing values and verify current membership', () => {
  assert.deepEqual(parseOptions('ram\tfill $ff\tRAM Fill (Restart)\tfill $ff|random\n', 'ram'), [
    {
      key: 'ram',
      value: 'fill $ff',
      description: 'RAM Fill (Restart)',
      values: ['fill $ff', 'random'],
    },
  ]);
  for (const input of ['ram\tinvalid\tRAM\ta|b', 'ram\ta\tRAM\ta|a', 'other\ta\tRAM\ta'])
    assert.throws(() => parseOptions(input, 'ram'));
});
test('option parsing rejects duplicate keys, controls, oversized lists and truncated details', () => {
  for (const input of [
    'a\tx\tA\na\tx\tA',
    'a\tx\tA\u0000',
    'a\tx',
    'a\tx\tA\ta|b',
    'x'.repeat(60001),
    Array.from({ length: 513 }, (_, i) => `key${i}\tx\tK`).join('\n'),
  ])
    assert.throws(() => parseOptions(input));
});
test('startup config cannot inject paths, lines, quotes or prototype keys', () => {
  assert.equal(
    coreOptionsConfig({ ram: 'fill $ff', region: 'Auto' }),
    'ram = "fill $ff"\nregion = "Auto"\n',
  );
  for (const input of [
    { region: 'a"\ncore_options_path = "evil' },
    { 'x\nSAVE_FILES': 'a' },
    JSON.parse('{"__proto__":"a"}'),
    { region: 'a\\b' },
  ])
    assert.throws(() => coreOptionsConfig(input));
});
