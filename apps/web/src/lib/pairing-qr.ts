import qr from 'qrcode-generator';

export function pairingQR(payload: string) {
  const code = qr(0, 'M');
  code.addData(payload);
  code.make();
  const size = code.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++)
      if (code.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
  return { size: size + 8, path };
}
