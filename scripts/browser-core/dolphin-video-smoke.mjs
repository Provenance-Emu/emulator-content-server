/** Original GameCube PPC instructions: fill a two-colour YUYV XFB and enable NTSC VI. */
export const dolphinVideoGeometry = Object.freeze({
  width: 320,
  height: 240,
  xfbAddress: 0x80100000,
  counterAddress: 0x80004000,
  entry: 0x80003100,
});

export function dolphinVideoSmokeDol({ wii = false } = {}) {
  const geometry = wii
    ? { ...dolphinVideoGeometry, entry: 0x80008000, counterAddress: 0x8000f800 }
    : dolphinVideoGeometry;
  const code = [];
  const emit = (word) => code.push(word >>> 0);
  const d = (op, register, base, immediate) =>
    emit((op << 26) | (register << 21) | (base << 16) | (immediate & 0xffff));
  const load = (register, value) => {
    d(15, register, 0, value >>> 16);
    d(24, register, register, value);
  };
  if (wii) {
    emit(0x7c13faa6); // mfspr r0,HID4: preserve the Broadway BAT-enable bits
    emit(0x7c13fba6); // mtspr HID4,r0: Dolphin detects this Wii-only initialization opcode
    load(6, 0x90001000);
    load(7, 0x57494931); // MEM2 only exists on Wii
    d(36, 7, 6, 0);
    d(32, 8, 6, 0);
    load(6, geometry.counterAddress + 8);
    d(36, 8, 6, 0);
    load(6, 0x80003140);
    d(32, 8, 6, 0); // actual IOS version installed by HLE executable boot
    load(6, geometry.counterAddress + 4);
    d(36, 8, 6, 0);
  }
  load(3, geometry.xfbAddress);
  for (const colour of [0x91369122, 0x29f0296e]) {
    load(4, colour); // green / blue in BT.601 Y0 Cb Y1 Cr order
    d(14, 5, 0, (dolphinVideoGeometry.width * dolphinVideoGeometry.height) / 4);
    emit(0x7ca903a6); // mtctr r5
    d(36, 4, 3, 0); // stw r4,0(r3)
    d(14, 3, 3, 4);
    emit(0x4200fff8); // bdnz back to stw
  }
  load(3, 0xcc002000);
  const vi16 = (offset, value) => {
    d(14, 4, 0, value);
    d(44, 4, 3, offset);
  };
  vi16(0x02, 0); // disable while changing timing
  vi16(0x00, (240 << 4) | 6); // 240 active lines, six equalization pulses
  vi16(0x0c, 5);
  vi16(0x0e, 22); // odd post/pre blanking
  vi16(0x10, 4);
  vi16(0x12, 23); // even post/pre blanking
  vi16(0x1c, 0x0010);
  vi16(0x1e, 0); // top XFB physical $00100000, byte addressing
  vi16(0x24, 0x0010);
  vi16(0x26, 0); // bottom points to the same complete field
  vi16(0x48, (20 << 8) | 20); // WPL and STD: 320 pixels, 640-byte stride
  vi16(0x02, 5); // enable non-interlaced NTSC
  emit(0x7c0004ac); // sync
  load(3, geometry.counterAddress);
  d(14, 5, 0, 0);
  d(14, 5, 5, 1);
  d(36, 5, 3, 0);
  emit(0x4bfffff8); // advancing original guest RAM

  const bytes = new Uint8Array(0x100 + code.length * 4);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 0x100],
    [0x48, geometry.entry],
    [0x90, code.length * 4],
    [0xd8, geometry.counterAddress],
    [0xdc, 32],
    [0xe0, geometry.entry],
  ])
    view.setUint32(offset, value, false);
  code.forEach((word, index) => {
    view.setUint32(0x100 + index * 4, word, false);
  });
  return bytes;
}
