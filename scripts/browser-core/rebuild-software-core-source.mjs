import { resolve } from 'node:path';
import { rebuildSoftwareCore } from './build-software-core.mjs';

if (process.argv.length !== 4)
  throw Error('Usage: rebuild-software-core-source.mjs EXTRACTED_SOURCE_ROOT NEW_OUTPUT');
console.log(
  JSON.stringify(
    rebuildSoftwareCore(...process.argv.slice(2).map((path) => resolve(path))),
    null,
    2,
  ),
);
