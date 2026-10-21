import { Readable } from 'node:stream';
import { ZipFile } from 'yazl';

export interface ZipMember {
  name: string;
  size: number;
  open(): Promise<Readable>;
}

/** ZIP64-capable streaming output. Open only one member at a time; no staging copy. */
export function streamZip(members: ZipMember[]): Readable {
  if (!members.length || members.length > 512) throw new Error('Invalid ZIP member count');
  const names = new Set<string>();
  for (const member of members) {
    if (
      !Number.isSafeInteger(member.size) ||
      member.size < 0 ||
      !member.name ||
      /[\\\0:]/.test(member.name) ||
      member.name.startsWith('/') ||
      member.name.split('/').some((p) => p === '.' || p === '..' || !p) ||
      names.has(member.name)
    )
      throw new Error('Invalid ZIP member');
    names.add(member.name);
  }
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  let active: Readable | null = null;
  let closed = false;
  output.once('close', () => {
    closed = true;
    active?.destroy();
  });
  zip.on('error', (error) => output.destroy(error));
  for (const member of members) {
    zip.addReadStreamLazy(member.name, { size: member.size, compress: false }, (callback) => {
      if (closed) {
        callback(new Error('Download closed'), Readable.from([]));
        return;
      }
      void member.open().then(
        (stream) => {
          if (closed) {
            stream.destroy();
            callback(new Error('Download closed'), Readable.from([]));
            return;
          }
          stream.once('error', (error) => output.destroy(error));
          active = stream;
          callback(null, stream);
        },
        (error) => callback(error, Readable.from([])),
      );
    });
  }
  zip.end({ forceZip64Format: true, comment: '' });
  return output;
}
