export function downloadBytes(
  bytes: Uint8Array,
  name: string,
  type = 'application/octet-stream',
): void {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download =
    name
      .split('/')
      .at(-1)
      ?.replace(/[^A-Za-z0-9._-]/g, '_') || 'download';
  document.body.append(link);
  link.click();
  link.remove();
  // Safari can start reading a download after the click handler has returned.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
