export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/bootstrap token:\s*\S+/gi, 'bootstrap token: [redacted]');
}
