import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, parseProject, PROJECT_LIMITS } from '../renderer/project.js';

const parameters = { attackMs: 5, decayMs: 200, sustainLevel: 0.7, releaseMs: 100, gainDb: -6, loop: false };
const zone = (id = 'one') => ({ id, name: '钢琴 C4.wav', rootNote: 60, keyLow: 48, keyHigh: 72, velocityLow: 1, velocityHigh: 127, startSeconds: 0.1, endSeconds: 1.5, loopStartSeconds: 0.4, loopEndSeconds: 1.2, wavBytes: Uint8Array.from([0, 1, 2, 253, 254, 255]).buffer });
const project = () => ({ name: '我的音色', parameters: { ...parameters }, zones: [zone(), { ...zone('two'), keyLow: 73, keyHigh: 96, velocityLow: 80 }] });

test('portable project round trip keeps sample bytes, Unicode, mappings and settings', () => {
  const original = project();
  const text = serializeProject(original);
  const parsed = parseProject(text);
  assert.equal(parsed.name, original.name);
  assert.deepEqual(parsed.parameters, original.parameters);
  assert.deepEqual(parsed.zones, original.zones);
  assert.equal(JSON.parse(text).version, 2);
});

test('version 1 projects migrate to matching envelope and full sample defaults', () => {
  const legacy = {
    version: 1, name: '旧工程', parameters: { attackMs: 5, releaseMs: 100, gainDb: -6, loop: true },
    zones: [{ id: 'one', name: '钢琴.wav', rootNote: 60, keyLow: 48, keyHigh: 72,
      velocityLow: 1, velocityHigh: 127, wavBase64: 'AAEC/f7/' }],
  };
  const migrated = parseProject(JSON.stringify(legacy));
  assert.deepEqual(migrated.parameters, { ...legacy.parameters, decayMs: 0, sustainLevel: 1 });
  assert.deepEqual(migrated.zones[0], { ...zone(), name: '钢琴.wav', startSeconds: 0,
    endSeconds: null, loopStartSeconds: 0, loopEndSeconds: null });
  // Null ends follow the sample's actual decoded duration on each device.
  assert.deepEqual(parseProject(serializeProject(migrated)), migrated);
});

test('v2 round trip preserves independent playback and loop ends following the sample', () => {
  for (const [endSeconds, loopEndSeconds] of [[null, null], [null, 1.2], [1.5, null], [1.5, 1.2]]) {
    const original = project();
    Object.assign(original.zones[0], { endSeconds, loopEndSeconds });
    assert.deepEqual(parseProject(serializeProject(original)), original);
  }
});

test('validate knowable ordering even when ends follow sample duration', () => {
  const source = JSON.parse(serializeProject(project()));
  for (const change of [
    z => Object.assign(z, { endSeconds: null, loopStartSeconds: 1, loopEndSeconds: 1 }),
    z => Object.assign(z, { endSeconds: 1, loopStartSeconds: 1, loopEndSeconds: null }),
    z => Object.assign(z, { endSeconds: null, loopStartSeconds: -1, loopEndSeconds: null }),
    z => Object.assign(z, { endSeconds: null, loopStartSeconds: 1.2, loopEndSeconds: 1.1 }),
  ]) {
    const invalid = structuredClone(source); change(invalid.zones[0]);
    assert.throws(() => parseProject(JSON.stringify(invalid)), /范围/);
  }
});

test('reject unsupported version, malformed schema, duplicate IDs and invalid mappings', () => {
  const source = JSON.parse(serializeProject(project()));
  for (const change of [
    o => o.version = 3,
    o => o.extra = true,
    o => o.zones[1].id = o.zones[0].id,
    o => o.zones[0].keyLow = 90,
    o => o.zones[0].velocityLow = 0,
    o => o.parameters.gainDb = 999,
    o => o.parameters.decayMs = -1,
    o => o.parameters.sustainLevel = 1.01,
    o => o.zones[0].startSeconds = -0.1,
    o => o.zones[0].startSeconds = o.zones[0].endSeconds,
    o => o.zones[0].loopStartSeconds = o.zones[0].startSeconds - 0.01,
    o => o.zones[0].loopEndSeconds = o.zones[0].loopStartSeconds,
    o => o.zones[0].loopEndSeconds = o.zones[0].endSeconds + 0.01,
    o => delete o.zones[0].loopEndSeconds,
  ]) {
    const invalid = structuredClone(source); change(invalid);
    assert.throws(() => parseProject(JSON.stringify(invalid)));
  }
  assert.throws(() => parseProject('{'));
});

test('reject non-finite values before serializing', () => {
  for (const change of [
    p => p.parameters.decayMs = NaN,
    p => p.parameters.sustainLevel = Infinity,
    p => p.zones[0].startSeconds = NaN,
    p => p.zones[0].endSeconds = Infinity,
    p => p.zones[0].loopStartSeconds = -Infinity,
  ]) {
    const invalid = project(); change(invalid);
    assert.throws(() => serializeProject(invalid));
  }
});

test('reject invalid, truncated and noncanonical base64 and empty samples', () => {
  const source = JSON.parse(serializeProject(project()));
  for (const bytes of ['', '%%%%', 'YQ=', 'YR==', 'YWJ=', 'AA=A']) {
    const invalid = structuredClone(source); invalid.zones[0].wavBase64 = bytes;
    assert.throws(() => parseProject(JSON.stringify(invalid)), bytes);
  }
});

test('reject oversize inputs before serializing sample contents', () => {
  assert.throws(() => parseProject(' '.repeat(PROJECT_LIMITS.jsonBytes + 1)), /64 MiB/);
  const large = project(); large.zones = [{ ...zone(), wavBytes: new ArrayBuffer(PROJECT_LIMITS.sampleBytes + 1) }];
  assert.throws(() => serializeProject(large), /32 MiB/);
  const many = project(); many.zones = Array.from({ length: PROJECT_LIMITS.zones + 1 }, (_, i) => zone(String(i)));
  assert.throws(() => serializeProject(many), /数量/);
});

test('serialize rejects wrong types without changing caller state', () => {
  const original = project();
  original.zones[0].keyHigh = 200;
  const before = structuredClone(original);
  assert.throws(() => serializeProject(original));
  assert.deepEqual(original, before);
});
