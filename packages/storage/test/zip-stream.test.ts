import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';

test('a disappearing disc member fails the ZIP stream without terminating the server process', async () => {
  const moduleUrl = new URL('../src/zip-stream.js', import.meta.url).href;
  const script = `import assert from 'node:assert/strict'; import {Readable} from 'node:stream'; import {streamZip} from ${JSON.stringify(moduleUrl)};
 const output=streamZip([{name:'Track.bin',size:3,async open(){return new Readable({read(){this.destroy(new Error('disk unavailable'));}});}}]);
 await assert.rejects(async()=>{for await (const chunk of output) void chunk;},/disk unavailable/);
 console.log('read failure contained');`;
  const result = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', script],
    { timeout: 3000 },
  );
  assert.match(result.stdout, /read failure contained/);
});
