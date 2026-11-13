// macOS's FSEvents setup can block in a synchronous open on mounted volumes.
// Keep those volumes on the scanner's async polling path.
export function usesVolumePolling(path: string, platform = process.platform): boolean {
  return platform === 'darwin' && path.startsWith('/Volumes/');
}
