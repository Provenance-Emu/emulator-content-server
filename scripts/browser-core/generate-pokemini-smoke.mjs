/** Original Minx cartridge. Uses LCD commands, toggling all-pixels mode while A is held. */
export function pokeMiniSmokeCartridge() {
  const rom = Buffer.alloc(32768, 0xff);
  rom.set([0x4d, 0x4e], 0x2100); // Cartridge signature read by the core's FreeBIOS
  const code = [0x9f, 0xc0, 0xb4, 0x20, 0xdd, 0x80, 0, 0xdd, 0xfe, 0xaf]; // IRQ off; N=$20; PRC off; LCD on
  const labels = new Map(),
    branches = [];
  const label = (name) => labels.set(name, code.length);
  const branch = (opcode, name) => {
    code.push(opcode, 0);
    branches.push([code.length - 1, name]);
  };
  label('poll');
  code.push(0x44, 0x52, 0x22, 1);
  branch(0xe6, 'pressed'); // Read active-low A
  code.push(0xdd, 0xfe, 0xa4);
  branch(0xf1, 'poll');
  label('pressed');
  code.push(0xdd, 0xfe, 0xa5);
  branch(0xf1, 'poll');
  // Minx short jumps are relative to the operand address, unlike SM83/6502 branches.
  for (const [offset, name] of branches) code[offset] = (labels.get(name) - offset) & 255;
  rom.set(code, 0x2102);
  return rom;
}
