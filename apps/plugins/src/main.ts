#!/usr/bin/env node
import { run } from './host.js';

const code = await run(process.argv, process.env, {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
process.exitCode = code;
