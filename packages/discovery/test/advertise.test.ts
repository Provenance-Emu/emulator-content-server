import assert from 'node:assert/strict';
import test from 'node:test';
import { bonjourTarget } from '../src/advertise.js';

test('Bonjour publishes a resolvable service target when the OS returns a short hostname', () => {
  assert.equal(bonjourTarget('studio'), 'studio.local');
  assert.equal(bonjourTarget('studio.local.'), 'studio.local');
  assert.equal(bonjourTarget('server.example.org'), 'server.example.org');
});
