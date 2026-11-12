export interface ServerUpdateSettings {
  channel: 'release' | 'nightly';
  mode: 'off' | 'manual' | 'automatic';
}

export interface ServerUpdateDecision {
  action: 'check' | 'install' | 'later' | 'skip';
  buildId?: string;
}

export interface ServerUpdateBuild {
  id: string;
  version: string;
  channel: ServerUpdateSettings['channel'];
  builtAt?: string;
}

export interface ServerUpdateHistoryEntry {
  build: ServerUpdateBuild;
  at: string;
  outcome: 'installed' | 'observed' | 'rolled-back';
}

export interface ServerUpdateStatus {
  supported: boolean;
  settings: ServerUpdateSettings;
  current?: ServerUpdateBuild;
  available?: ServerUpdateBuild;
  phase: 'idle' | 'checking' | 'downloading' | 'restarting';
  prompt: boolean;
  message?: string;
  lastCheckedAt?: string;
  history?: ServerUpdateHistoryEntry[];
}
