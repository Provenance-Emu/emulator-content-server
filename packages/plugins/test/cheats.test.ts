import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createLibretroCheatsProvider,
  localCheatsProvider,
  normalizeCheats,
} from '../src/cheats.js';
import { runMatching } from '../src/matching.js';

const input = { name: 'Generated (USA).nes', systemId: 'com.provenance.nes', companions: [] };
test('cheat files are validated and stored with every code disabled', () => {
  const bytes = new TextEncoder().encode(
    'cheats = 1\ncheat0_desc = "Generated example"\ncheat0_code = "0000:0000"\ncheat0_enable = true\n',
  );
  const parsed = normalizeCheats(bytes);
  assert.equal(parsed.count, 1);
  assert.match(parsed.text, /cheat0_enable = "false"/);
  assert.throws(() => normalizeCheats(new TextEncoder().encode('cheats = 10001')));
  assert.throws(() => normalizeCheats(new TextEncoder().encode('cheats = 1\ncheat7_code = "bad"')));
});
test('local cheat provider matches system-sidecar names without claiming checksum verification', async () => {
  const result = await runMatching(
    {
      ...input,
      companions: [
        { id: 'yes', name: 'Generated (USA) (Game Genie).cht', cheats: { count: 1 } },
        { id: 'no', name: 'Generated (Japan).cht', cheats: { count: 1 } },
      ],
    },
    [localCheatsProvider],
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]?.fileId, 'yes');
  assert.equal(result.candidates[0]?.confidence, 'name');
});
test('online cheats use a bounded public index, preserve edition matching and respect online opt-in', async () => {
  let calls = 0;
  const provider = createLibretroCheatsProvider(async (url) => {
    calls++;
    if (String(url).endsWith('/contents/cht'))
      return Response.json([
        { name: 'Nintendo - Nintendo Entertainment System', type: 'dir', sha: 'a'.repeat(40) },
      ]);
    assert.equal(
      String(url),
      'https://api.github.com/repos/libretro/libretro-database/git/trees/' + 'a'.repeat(40),
    );
    return Response.json({
      truncated: false,
      tree: [
        { type: 'blob', path: 'Generated (USA) (Game Genie).cht' },
        { type: 'blob', path: 'Generated (Japan).cht' },
        { type: 'blob', path: '../escape.cht' },
      ],
    });
  });
  assert.equal((await runMatching(input, [provider])).candidates.length, 0);
  assert.equal(calls, 0);
  const found = await runMatching({ ...input, online: true }, [provider]);
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0]?.kind, 'cheats');
  assert.ok(
    found.candidates[0]?.url?.includes('/cht/Nintendo%20-%20Nintendo%20Entertainment%20System/'),
  );
  assert.equal(calls, 2);
});
