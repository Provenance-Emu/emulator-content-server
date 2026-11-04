/** Original MIPS-I program; no Sony firmware, SDK, game, or third-party executable. */
export function psxSmokeCode() {
  const words = [];
  const emit = (word) => words.push(word >>> 0);
  const load = (register, value) => {
    emit(0x3c000000 | (register << 16) | (value >>> 16)); // lui
    emit(0x34000000 | (register << 21) | (register << 16) | (value & 0xffff)); // ori
  };
  const store = (register, addressRegister, offset = 0) =>
    emit(0xac000000 | (addressRegister << 21) | (register << 16) | offset);
  load(8, 0x1f801810); // GP0; GP1 is the next word.
  for (const value of [0, 0x03000000, 0x05000000, 0x06c60260, 0x07042018, 0x08000001]) {
    load(9, value);
    store(9, 8, 4);
  }
  // GPU fill command: green, (0,0), 320x240.
  for (const value of [0x0200ff00, 0, 0x00f00140]) {
    load(9, value);
    store(9, 8);
  }
  load(10, 0x80020000); // Guest progress counter outside program and HLE work area.
  load(11, 0);
  load(12, 0x0200ff00);
  load(13, 0x00010010); // Refresh a 16x1 green strip without a full-screen fill each loop.
  const loop = words.length;
  store(12, 8);
  store(0, 8);
  store(13, 8);
  emit(0x256b0001); // addiu t3,t3,1
  store(11, 10);
  emit(0x10000000 | ((loop - (words.length + 1)) & 0xffff)); // beq zero,zero,loop
  emit(0); // Branch delay slot nop.
  const code = Buffer.alloc(words.length * 4);
  words.forEach((word, index) => {
    code.writeUInt32LE(word, index * 4);
  });
  return code;
}

/** Sector-aligned PS-X EXE with explicit entry, RAM load address, and valid stack. */
export function psxSmokeExe() {
  const code = psxSmokeCode(),
    dataSize = Math.ceil(code.length / 0x800) * 0x800;
  const exe = Buffer.alloc(0x800 + dataSize);
  exe.write('PS-X EXE', 0, 'ascii');
  exe.writeUInt32LE(0x80010000, 0x10);
  exe.writeUInt32LE(0x80010000, 0x18);
  exe.writeUInt32LE(dataSize, 0x1c);
  exe.writeUInt32LE(0x801fff00, 0x30);
  code.copy(exe, 0x800);
  return exe;
}

/** A small original ISO9660 volume containing SYSTEM.CNF and the generated EXE. */
export function psxSmokeIso() {
  const exe = psxSmokeExe();
  const image = Buffer.alloc(32 * 2048);
  const twin32 = (bytes, at, value) => {
    bytes.writeUInt32LE(value, at);
    bytes.writeUInt32BE(value, at + 4);
  };
  const twin16 = (bytes, at, value) => {
    bytes.writeUInt16LE(value, at);
    bytes.writeUInt16BE(value, at + 2);
  };
  const record = (lba, size, name, flags = 0) => {
    const row = Buffer.alloc(33 + name.length + (name.length % 2 === 0 ? 1 : 0));
    row[0] = row.length;
    twin32(row, 2, lba);
    twin32(row, 10, size);
    row.set([126, 1, 1, 0, 0, 0, 0], 18); // Fixed timestamp for reproducibility.
    row[25] = flags;
    twin16(row, 28, 1);
    row[32] = name.length;
    name.copy(row, 33);
    return row;
  };
  const pvd = image.subarray(16 * 2048, 17 * 2048);
  pvd[0] = 1;
  pvd.write('CD001', 1);
  pvd[6] = 1;
  pvd.fill(32, 8, 72);
  pvd.write('PLAYSTATION', 8);
  pvd.write('ECS_ORIGINAL', 40);
  twin32(pvd, 80, 32);
  twin16(pvd, 120, 1);
  twin16(pvd, 124, 1);
  twin16(pvd, 128, 2048);
  twin32(pvd, 132, 10);
  pvd.writeUInt32LE(18, 140);
  pvd.writeUInt32BE(19, 148);
  const root = record(20, 2048, Buffer.from([0]), 2);
  root.copy(pvd, 156);
  const terminator = image.subarray(17 * 2048, 18 * 2048);
  terminator[0] = 255;
  terminator.write('CD001', 1);
  terminator[6] = 1;
  for (const [lba, big] of [
    [18, false],
    [19, true],
  ]) {
    const table = image.subarray(lba * 2048, (lba + 1) * 2048);
    table[0] = 1;
    if (big) {
      table.writeUInt32BE(20, 2);
      table.writeUInt16BE(1, 6);
    } else {
      table.writeUInt32LE(20, 2);
      table.writeUInt16LE(1, 6);
    }
  }
  const config = Buffer.from(
    'BOOT = cdrom:\\ECS_TEST.EXE;1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n',
  );
  Buffer.concat([
    root,
    record(20, 2048, Buffer.from([1]), 2),
    record(21, config.length, Buffer.from('SYSTEM.CNF;1')),
    record(22, exe.length, Buffer.from('ECS_TEST.EXE;1')),
  ]).copy(image, 20 * 2048);
  config.copy(image, 21 * 2048);
  exe.copy(image, 22 * 2048);
  return image;
}

/** Original Mode 2 data track for decoder boot probes, not physical-disc mastering. */
export function psxSmokeMode2Track() {
  const iso = psxSmokeIso();
  const track = Buffer.alloc((iso.length / 2048) * 2352);
  const bcd = (value) => (Math.floor(value / 10) << 4) | (value % 10);
  for (let lba = 0; lba < iso.length / 2048; lba++) {
    const sector = track.subarray(lba * 2352, (lba + 1) * 2352);
    sector.fill(255, 1, 11);
    const frame = lba + 150;
    sector[12] = bcd(Math.floor(frame / (60 * 75)));
    sector[13] = bcd(Math.floor(frame / 75) % 60);
    sector[14] = bcd(frame % 75);
    sector[15] = 2;
    sector.set([0, 0, 8, 0, 0, 0, 8, 0], 16);
    iso.copy(sector, 24, lba * 2048, (lba + 1) * 2048);
    // Error-correction fields are zero: this fixture tests emulator data loading only.
  }
  return track;
}
