import { libarchiveWasm } from 'libarchive-wasm';

export async function decodeSevenZip(
  bytes: Uint8Array,
  extensions: string[],
  limit: number,
  options?: Parameters<typeof libarchiveWasm>[0],
): Promise<{ bytes: Uint8Array<ArrayBuffer>; extension: string }> {
  if (bytes.length < 32 || bytes.length > limit)
    throw new Error('Invalid 7z archive or archive exceeds this emulator’s size limit.');
  if (![0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, index) => bytes[index] === byte))
    throw new Error('Invalid 7z archive signature.');

  const wasm = await libarchiveWasm(options);
  const input = wasm.module._malloc(bytes.length);
  if (!input) throw new Error('Unable to allocate memory for the 7z archive.');
  let archive = 0;
  try {
    wasm.module.HEAP8.set(bytes, input);
    archive = wasm.read_new_memory(input, bytes.length, undefined);
    let count = 0;
    let result: Awaited<ReturnType<typeof decodeSevenZip>> | undefined;
    for (;;) {
      const entry = wasm.read_next_entry(archive);
      if (!entry) {
        if (wasm.error_string(archive)) throw new Error('Invalid or encrypted 7z archive.');
        break;
      }
      if (++count > 512) throw new Error('Archive has too many files.');
      const name = wasm.entry_pathname(entry);
      const type = wasm.entry_filetype(entry);
      if (
        !name ||
        name.length > 1024 ||
        wasm.entry_is_encrypted(entry) ||
        wasm.entry_symlink(entry) ||
        wasm.entry_hardlink(entry) ||
        (type !== 16384 && type !== 32768)
      )
        throw new Error('Encrypted, linked or special archive entries are unsupported.');
      if (type === 16384) continue;
      if (/\.(cue|gdi|ccd|m3u)$/i.test(name))
        throw new Error('Extract this disc set and rescan its library folder to play it.');
      const extension = name.split('.').at(-1)?.toLowerCase();
      if (!extension || !extensions.includes(extension)) continue;
      if (result) throw new Error('This 7z contains multiple game files.');
      const size = wasm.entry_size(entry);
      if (!Number.isSafeInteger(size) || size <= 0 || size > limit)
        throw new Error('Expanded game exceeds this emulator’s size limit.');
      const output = wasm.module._malloc(size + 1);
      if (!output) throw new Error('Unable to allocate memory for the expanded game.');
      try {
        const read = wasm.read_data(archive, output, size + 1);
        if (read !== size) throw new Error('Expanded game size did not match the archive.');
        result = {
          bytes: Uint8Array.from(wasm.module.HEAP8.subarray(output, output + size)),
          extension,
        };
      } finally {
        wasm.module._free(output);
      }
    }
    if (!result)
      throw new Error('This 7z contains no game file supported by the selected emulator.');
    return result;
  } finally {
    try {
      if (archive) wasm.read_free(archive);
    } finally {
      wasm.module._free(input);
    }
  }
}
