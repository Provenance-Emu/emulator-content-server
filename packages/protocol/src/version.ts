export const API_MAJOR = 1;
export const API_MINOR = 0;
export const API_PATH = '/api/v1';
export const PROTOCOL_VERSION = '1.0.0';

export function isCompatibleMajor(major: number): boolean {
  return major === API_MAJOR;
}

export function nextMajorPath(major: number): string {
  return `/api/${major}`;
}
