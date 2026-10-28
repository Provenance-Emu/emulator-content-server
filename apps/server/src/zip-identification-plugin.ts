import type { IdentificationPlugin } from '@ecs/plugins/rom-identification';
import { boundedZipFingerprint } from './matching-files.js';

/** Infrastructure adapter loaded only in the isolated identification worker. */
const plugin: IdentificationPlugin = {
  id: 'org.ecs.identify.zip',
  supports: (request) => /\.zip$/i.test(request.name),
  async identify(request, _reader, signal) {
    const fingerprint = await boundedZipFingerprint(request.path, signal);
    return {
      version: 1,
      pluginIds: [],
      hashes: fingerprint
        ? (['md5', 'crc32'] as const).map((algorithm) => ({
            algorithm,
            value: fingerprint[algorithm],
            size: fingerprint.size,
            representation: 'zip-member',
            verified: true,
          }))
        : [],
      identifiers: [],
      names: [],
      warnings: fingerprint ? [] : ['zip-no-single-bounded-rom'],
    };
  },
};
export default plugin;
