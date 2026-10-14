export class PluginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}
