import { API_MAJOR, API_MINOR, API_PATH } from './version.js';

export interface Capabilities {
  protocol: {
    major: number;
    minor: number;
    path: string;
  };
  minClientVersion: string;
  features: {
    rangeRequests: boolean;
    multiRange: boolean;
    resumableUploads: boolean;
    changeFeed: boolean;
    guestGrants: boolean;
    virtualFormats: string[];
    webdav: boolean;
    natTraversal: boolean;
    webPlayback?: boolean;
  };
  limits: {
    maxUploadBytes: number;
    maxPageSize: number;
  };
  authentication: Array<'bearer' | 'bootstrap' | 'lan'>;
  /** Present once the server can say whether an owner account exists. */
  bootstrapped?: boolean;
}

export function buildCapabilities(input: {
  maxUploadBytes: number;
  virtualFormats?: string[];
  bootstrapped?: boolean;
  /** True when this process will admit the local network without a token. */
  lanOpen?: boolean;
  webdavEnabled?: boolean;
  webPlayback?: boolean;
}): Capabilities {
  return {
    protocol: { major: API_MAJOR, minor: API_MINOR, path: API_PATH },
    minClientVersion: '0.1.0',
    features: {
      rangeRequests: true,
      multiRange: false,
      resumableUploads: true,
      changeFeed: true,
      guestGrants: true,
      virtualFormats: input.virtualFormats ?? [],
      webdav: input.webdavEnabled === true,
      natTraversal: false,
      webPlayback: input.webPlayback === true,
    },
    limits: {
      maxUploadBytes: input.maxUploadBytes,
      maxPageSize: 100,
    },
    authentication: input.lanOpen ? ['bearer', 'bootstrap', 'lan'] : ['bearer', 'bootstrap'],
    ...(input.bootstrapped === undefined ? {} : { bootstrapped: input.bootstrapped }),
  };
}
