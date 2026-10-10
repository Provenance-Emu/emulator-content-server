import type { Capabilities } from './generated.js';

export interface ResumePlan {
  offset: number;
  range: string | null;
}

export type DownloadInstruction = 'append' | 'restart' | 'not-modified' | 'unsatisfiable';

export function planResume(localBytes: number, totalBytes: number | null): ResumePlan {
  if (localBytes < 0 || (totalBytes !== null && localBytes > totalBytes)) {
    return { offset: 0, range: null };
  }
  if (localBytes === 0) return { offset: 0, range: null };
  return { offset: localBytes, range: `bytes=${localBytes}-` };
}

export function interpretDownload(status: number, requestedOffset: number): DownloadInstruction {
  if (status === 304) return 'not-modified';
  if (status === 416) return 'unsatisfiable';
  if (status === 200 && requestedOffset > 0) return 'restart';
  if (status === 206 || status === 200) return 'append';
  return 'restart';
}

export class ContentClient {
  constructor(
    private readonly baseUrl: string,
    private token?: string,
  ) {}

  setToken(token: string | undefined): void {
    this.token = token;
  }

  capabilities(): Promise<Capabilities> {
    return this.get('/api/v1/capabilities');
  }

  private async get<T>(path: string): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), { headers: this.headers() });
    if (!response.ok) throw new Error(`Content request failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }
}
