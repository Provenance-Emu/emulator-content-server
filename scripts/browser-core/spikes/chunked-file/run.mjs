import factory from './spike.mjs';

const CHUNK = 4 * 1024 * 1024;
const SIZE = 1536 * 1024 * 1024 + 12345; // 1.5 GiB and a ragged end: over the 512 MiB limit
// Each chunk is made when first read, so the spike proves the mechanism without 1.5 GiB of RAM.
const made = new Map();
let reads = 0;
const byteAt = (n) => ((n % 251) + Math.floor(n / CHUNK) * 3 + 1) & 0xff;
function chunk(index) {
  let bytes = made.get(index);
  if (!bytes) {
    const start = index * CHUNK;
    bytes = new Uint8Array(Math.min(CHUNK, SIZE - start));
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = byteAt(start + i); // sparse fill
    for (let i = 0; i < Math.min(64, bytes.length); i++) bytes[i] = byteAt(start + i);
    made.set(index, bytes);
  }
  return bytes;
}
const lines = [];
const module = await factory({ print: (t) => lines.push(t), noInitialRun: true });
const { FS } = module;
FS.mkdirTree('/ecs/content');
// The same steps the emulator frame takes (apps/web/public/play/sandbox.html, 'mount-chunks').
FS.writeFile('/ecs/content/game.chd', new Uint8Array(0));
const node = FS.lookupPath('/ecs/content/game.chd').node;
const refuse = (code) => () => {
  throw new FS.ErrnoError(code);
};
Object.defineProperty(node, 'usedBytes', { configurable: true, get: () => SIZE });
node.stream_ops = {
  ...node.stream_ops,
  read(stream, buffer, offset, length, position) {
    reads++;
    if (position >= SIZE) return 0;
    const count = Math.min(length, SIZE - position);
    let done = 0;
    while (done < count) {
      const at = position + done;
      const piece = chunk(Math.floor(at / CHUNK));
      const from = at % CHUNK;
      const take = Math.min(count - done, piece.byteLength - from);
      buffer.set(piece.subarray(from, from + take), offset + done);
      done += take;
    }
    return count;
  },
  write: refuse(30),
  mmap: refuse(19),
};
const probes = [
  0,
  CHUNK - 4,
  600 * 1024 * 1024 + 8192,
  1024 * 1024 * 1024 + 4096,
  SIZE - (SIZE % 4096),
  SIZE - 3,
];
module.callMain(['/ecs/content/game.chd', ...probes.map(String)]);
const expect = (at, n) =>
  Array.from({ length: n }, (_, k) => {
    const p = at + k;
    const inHead = p % CHUNK < 64;
    const onGrid = (p % CHUNK) % 4096 === 0;
    return (inHead || onGrid ? byteAt(p) : 0).toString(16).padStart(2, '0');
  }).join('');
let ok = lines[0] === `size ${SIZE}`;
probes.forEach((at, i) => {
  const n = Math.min(8, SIZE - at);
  ok &&= lines[i + 1] === `${at}:${n}:${expect(at, n)}`;
});
console.log(lines.join('\n'));
console.log(
  JSON.stringify({
    ok,
    chunksTouched: made.size,
    reads,
    heapMB: Math.round(module.HEAP8.length / 1048576),
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  }),
);
