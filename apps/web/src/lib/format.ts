const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** A size a person can read at a glance, which is all a listing needs. */
export function bytes(size: number): string {
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${UNITS.at(unit) ?? 'B'}`;
}
