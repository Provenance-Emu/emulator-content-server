import type { DatRecord } from './matching.js';

/** Read only scalar identity fields from Flycast's public Game array; never evaluate C++. */
export function parseFlycastCatalog(source: string): DatRecord[] {
  if (Buffer.byteLength(source) > 4 * 1024 * 1024) throw new Error('Arcade catalog too large');
  const start = /\bconst\s+Game\s+Games\s*\[\s*\]\s*=\s*\{/.exec(source);
  if (!start) throw new Error('Arcade catalog format changed');
  const input = source.slice(start.index + start[0].length);
  const tokens =
    input.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|[{},;]|[^\s{},;]+/g) ?? [];
  const records: DatRecord[] = [];
  const string = (value: string | undefined) =>
    value && /^"(?:\\.|[^"\\])*"$/.test(value)
      ? value.slice(1, -1).replace(/\\(["\\])/g, '$1')
      : null;
  let depth = 1,
    fields: string[] = [],
    field: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('//') || token.startsWith('/*')) continue;
    if (token === '{') {
      if (depth === 1) {
        fields = [];
        field = [];
      }
      depth++;
      continue;
    }
    if (token === '}') {
      if (depth === 2) {
        if (field.length) fields.push(field.join(' '));
        const id = string(fields[0]),
          title = string(fields[2]),
          bios = string(fields[5]);
        const systemId =
          bios === 'segasp'
            ? null
            : bios === 'naomi2'
              ? 'com.provenance.naomi2'
              : fields[6] === 'AW' || bios === 'awbios'
                ? 'com.provenance.atomiswave'
                : /^naomi(?:-|$)/.test(bios ?? '') ||
                    ['M1', 'M2', 'M4', 'GD'].includes(fields[6] ?? '')
                  ? 'com.provenance.naomi'
                  : null;
        if (id && /^[a-z0-9_]+$/.test(id) && title && title.length <= 512 && systemId) {
          const serial = string(fields[9]);
          records.push({
            name: id,
            title,
            setIds: [id],
            systemId,
            source: 'Flycast game catalog',
            aliases: serial && /^(?:gds|gdl|cdv)-[a-z0-9-]+$/i.test(serial) ? [serial] : [],
            ...(serial && /^(?:gds|gdl|cdv)-[a-z0-9-]+$/i.test(serial)
              ? { serials: [serial] }
              : {}),
          });
          if (records.length > 5000) throw new Error('Arcade catalog too large');
        }
      }
      depth--;
      if (depth === 0) break;
      continue;
    }
    if (depth === 2) {
      if (token === ',') {
        fields.push(field.join(' '));
        field = [];
      } else field.push(token);
    }
  }
  if (depth !== 0 || !records.length) throw new Error('Arcade catalog format changed');
  return records;
}
