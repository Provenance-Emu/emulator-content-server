/** Example format: ECSIDENT magic, then a 16-byte ASCII identifier. No game data included. */
export default {
  async identify(request, reader) {
    const facts = { version: 1, pluginIds: [], hashes: [], identifiers: [], names: [], warnings: [] };
    if (request.size < 24) return facts;
    const header = Buffer.from(await reader.read(0, 24));
    if (header.toString('ascii', 0, 8) !== 'ECSIDENT') return facts;
    const value = header.toString('ascii', 8).replace(/\0+$/, '');
    if (/^[A-Z0-9-]{1,16}$/.test(value))
      facts.identifiers.push({ type: 'serial', value, systemId: null, verified: true });
    return facts;
  },
  async search() { return []; },
};
