import test from 'node:test';
import assert from 'node:assert/strict';
import { autoMapZones } from '../renderer/zone-mapping.js';

test('maps unordered roots to contiguous ranges and retains input order', () => {
  const zones = [
    { id: 'high', rootNote: 84, keyLow: 3, keyHigh: 8 },
    { id: 'low', rootNote: 48, keyLow: 12, keyHigh: 16 },
    { id: 'middle', rootNote: 60, keyLow: 4, keyHigh: 20 },
  ];
  assert.deepEqual(autoMapZones(zones), [
    { ...zones[0], keyLow: 73, keyHigh: 127 },
    { ...zones[1], keyLow: 0, keyHigh: 54 },
    { ...zones[2], keyLow: 55, keyHigh: 72 },
  ]);
});

test('ties go to the lower root; adjacent and extreme roots still own their own notes', () => {
  const result = autoMapZones([0, 1, 3, 127].map(rootNote => ({ rootNote })));
  assert.deepEqual(result.map(({ keyLow, keyHigh }) => [keyLow, keyHigh]), [
    [0, 0], [1, 2], [3, 65], [66, 127],
  ]);
});

test('multiple zones with the same root share the range and retain layers and referenced data', () => {
  const audio = new ArrayBuffer(8), metadata = { name: 'layer' };
  const zones = [
    { rootNote: 60, velocityLow: 1, velocityHigh: 64, keyLow: 10, keyHigh: 20, audio, metadata },
    { rootNote: 72, velocityLow: 1, velocityHigh: 127, keyLow: 10, keyHigh: 20, audio, metadata },
    { rootNote: 60, velocityLow: 65, velocityHigh: 127, keyLow: 21, keyHigh: 30, audio, metadata },
  ];
  const before = zones.map(z => ({ ...z }));
  const mapped = autoMapZones(zones);
  assert.deepEqual(mapped.map(({ keyLow, keyHigh }) => [keyLow, keyHigh]), [[0, 66], [67, 127], [0, 66]]);
  assert.deepEqual(mapped.map(({ velocityLow, velocityHigh }) => [velocityLow, velocityHigh]), [[1, 64], [1, 127], [65, 127]]);
  for (let i = 0; i < zones.length; i++) {
    assert.notStrictEqual(mapped[i], zones[i]);
    assert.strictEqual(mapped[i].audio, audio);
    assert.strictEqual(mapped[i].metadata, metadata);
    assert.deepEqual(zones[i], before[i]);
  }
});

test('a single root or a set of identical roots covers the whole keyboard', () => {
  for (const rootNote of [0, 60, 127]) {
    assert.deepEqual(autoMapZones([{ rootNote }]), [{ rootNote, keyLow: 0, keyHigh: 127 }]);
    assert.deepEqual(autoMapZones([{ rootNote }, { rootNote }]).map(z => [z.keyLow, z.keyHigh]), [[0, 127], [0, 127]]);
  }
});

test('rejects invalid inputs and root notes without altering any zone', () => {
  for (const invalid of [null, undefined, {}, 'zones', []]) assert.throws(() => autoMapZones(invalid));
  for (const rootNote of [undefined, null, NaN, Infinity, -1, 128, 60.5, '60']) {
    const good = { rootNote: 60, keyLow: 12, keyHigh: 24 };
    assert.throws(() => autoMapZones([good, { rootNote }]));
    assert.deepEqual(good, { rootNote: 60, keyLow: 12, keyHigh: 24 });
  }
  for (const bad of [null, undefined, [], 60, '60']) assert.throws(() => autoMapZones([bad]));
});
