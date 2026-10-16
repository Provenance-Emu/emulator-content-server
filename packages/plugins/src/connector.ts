export interface RemoteObject {
  relativePath: string;
  locator: string;
  size: number;
  sha256: string | null;
  kind: string;
}

export interface StorageConnector {
  readonly id: string;
  readonly scheme: string;
  readonly writable: boolean;
  list(): Promise<RemoteObject[]>;
  read(object: RemoteObject, start: number, endInclusive: number): Promise<Uint8Array>;
  put?(relativePath: string, bytes: Uint8Array): Promise<void>;
}
