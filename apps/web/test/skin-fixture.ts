import { deflateSync } from 'node:zlib';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
export function crc32(bytes: Uint8Array) {
  let n = 0xffffffff;
  for (const b of bytes) {
    n ^= b;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
export function skinPng(width = 360, height = 520) {
  const chunk = (name: string, data: Uint8Array) => {
    const b = Buffer.alloc(data.length + 12);
    b.writeUInt32BE(data.length);
    b.write(name, 4);
    b.set(data, 8);
    b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
    return b;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 270; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 4 + 1) + 1 + x * 4;
      rows.set([70, 145, 120, 255], i);
    }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', head),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', new Uint8Array()),
    ]),
  );
}
export function skinPdf() {
  const stream = '.2 .6 .5 rg 0 0 360 250 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 520] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [o, s] of objects.entries()) {
    offsets.push(text.length);
    text += `${o + 1} 0 obj\n${s}\nendobj\n`;
  }
  return finishPdf(text, offsets);
}
function finishPdf(text: string, offsets: number[]) {
  const x = text.length;
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, '0') + ' 00000 n \n')
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(text);
}
export function skinInfo(asset = 'art.png') {
  return {
    name: 'Generated Pebble',
    identifier: 'test.pebble',
    gameTypeIdentifier: 'com.rileytestut.delta.game.nes',
    author: 'Test generator',
    representations: {
      iphone: {
        edgeToEdge: {
          portrait: {
            assets: { small: asset },
            mappingSize: { width: 360, height: 520 },
            screens: [{ outputFrame: { x: 0, y: 0, width: 360, height: 270 } }],
            items: [
              { inputs: ['a'], frame: { x: 290, y: 340, width: 56, height: 56 } },
              { inputs: ['a', 'b'], frame: { x: 180, y: 450, width: 90, height: 28 } },
              {
                inputs: { up: 'up', down: 'down', left: 'left', right: 'right' },
                frame: { x: 14, y: 300, width: 120, height: 120 },
              },
            ],
          },
        },
      },
    },
  };
}
export async function skinZip(
  info: unknown = skinInfo(),
  extra: Record<string, Uint8Array> = { 'art.png': skinPng() },
  level = 0,
) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false, level });
  await writer.add(
    'info.json',
    new Uint8ArrayReader(new TextEncoder().encode(JSON.stringify(info))),
  );
  for (const [name, bytes] of Object.entries(extra))
    await writer.add(name, new Uint8ArrayReader(bytes));
  return writer.close();
}

export function skinLargeImagePdf() {
  // A valid compressed 9 MP image on a small page exercises the embedded-image cap.
  const stream = 'q 360 0 0 520 0 0 cm /Huge Do Q';
  const image = deflateSync(new Uint8Array(3000 * 3000)).toString('hex') + '>';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 520] /Resources << /XObject << /Huge 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 3000 /Height 3000 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/ASCIIHexDecode /FlateDecode] /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ];
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [o, s] of objects.entries()) {
    offsets.push(text.length);
    text += `${o + 1} 0 obj\n${s}\nendobj\n`;
  }
  return finishPdf(text, offsets);
}
