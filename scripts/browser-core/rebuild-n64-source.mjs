import { resolve } from 'node:path';
import { rebuildN64Source } from './n64-source.mjs';

if (process.argv.length !== 4) throw Error('Usage: rebuild-n64-source.mjs SOURCE_STAGE NEW_PLAYER');
console.log(
  JSON.stringify(rebuildN64Source(...process.argv.slice(2).map((path) => resolve(path))), null, 2),
);
