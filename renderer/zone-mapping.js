/**
 * Assign a complete MIDI key range to each distinct sample root.
 * Roots at the same note share a range, preserving velocity layers.
 * A midpoint exactly between roots is assigned to the lower root.
 * The original zones and all referenced sample data are left untouched.
 */
export function autoMapZones(zones) {
  if (!Array.isArray(zones)) throw new TypeError('Zones must be an array');
  if (zones.length === 0) throw new RangeError('At least one zone is required');

  const roots = new Set();
  for (const zone of zones) {
    if (!zone || typeof zone !== 'object' || Array.isArray(zone)) throw new TypeError('Each zone must be an object');
    if (!Number.isInteger(zone.rootNote) || zone.rootNote < 0 || zone.rootNote > 127) throw new RangeError('Invalid root note');
    roots.add(zone.rootNote);
  }

  const sorted = [...roots].sort((a, b) => a - b);
  const ranges = new Map();
  let low = 0;
  for (let i = 0; i < sorted.length; i++) {
    const high = i + 1 < sorted.length ? Math.floor((sorted[i] + sorted[i + 1]) / 2) : 127;
    ranges.set(sorted[i], { keyLow: low, keyHigh: high });
    low = high + 1;
  }
  return zones.map(zone => ({ ...zone, ...ranges.get(zone.rootNote) }));
}
