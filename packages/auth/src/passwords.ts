import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';

const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replaceAll('=', '');
}

function unb64(value: string): Buffer {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = argon2id(password, salt, {
    t: ITERATIONS,
    m: MEMORY_KIB,
    p: PARALLELISM,
    dkLen: HASH_LENGTH,
  });
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}$${b64(salt)}$${b64(hash)}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[1] !== 'argon2id' || parts[2] !== 'v=19') return false;
  const params = parts[3] ?? '';
  const saltPart = parts[4] ?? '';
  const hashPart = parts[5] ?? '';
  const values = new Map(params.split(',').map((pair) => pair.split('=') as [string, string]));
  const memory = Number(values.get('m'));
  const iterations = Number(values.get('t'));
  const parallelism = Number(values.get('p'));
  if (
    ![memory, iterations, parallelism].every((value) => Number.isSafeInteger(value) && value > 0)
  ) {
    return false;
  }
  const salt = unb64(saltPart);
  const expected = unb64(hashPart);
  const actual = Buffer.from(
    argon2id(password, salt, {
      t: iterations,
      m: memory,
      p: parallelism,
      dkLen: expected.length,
    }),
  );
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
