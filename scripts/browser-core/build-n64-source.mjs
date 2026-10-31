import { resolve } from 'node:path';
import { buildN64Source } from './n64-source.mjs';

if (process.argv.length !== 6)
  throw Error('Usage: build-n64-source.mjs FRONTEND CORE NEW_SOURCE_STAGE NEW_PLAYER');
console.log(
  JSON.stringify(buildN64Source(...process.argv.slice(2).map((path) => resolve(path))), null, 2),
);
