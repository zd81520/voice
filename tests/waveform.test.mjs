import test from 'node:test';
import assert from 'node:assert/strict';
import { WaveformView, adjustRanges, computePeaks, validRanges } from '../renderer/waveform.js';

const ranges = { startSeconds: 1, endSeconds: 9, loopStartSeconds: 2, loopEndSeconds: 8 };

test('only finite, ordered ranges inside the sample are accepted', () => {
  assert.equal(validRanges(ranges, 10), true);
  assert.equal(validRanges({...ranges, loopStartSeconds: 8}, 10), false);
  assert.equal(validRanges({...ranges, startSeconds: 3}, 10), false);
  assert.equal(validRanges({...ranges, endSeconds: 11}, 10), false);
  assert.equal(validRanges({...ranges, endSeconds: NaN}, 10), false);
  assert.equal(validRanges(null, 10), false);
});

test('dragging each marker is clamped to its valid interval', () => {
  for (const field of Object.keys(ranges)) {
    for (const position of [-100, 0, 1.5, 5, 8.5, 10, 100]) {
      const updated = adjustRanges(field, position, ranges, 10, 48000);
      assert.equal(validRanges(updated, 10), true, `${field} at ${position}`);
    }
  }
  assert.equal(adjustRanges('unknown', 3, ranges, 10, 48000), null);
  assert.equal(adjustRanges('startSeconds', NaN, ranges, 10, 48000), null);
});

test('trimming full-file loops also moves the corresponding loop boundary', () => {
  const full = {startSeconds: 0, endSeconds: 10, loopStartSeconds: 0, loopEndSeconds: 10};
  assert.deepEqual(adjustRanges('startSeconds', 3, full, 10, 48000), {...full, startSeconds: 3, loopStartSeconds: 3});
  assert.deepEqual(adjustRanges('endSeconds', 7, full, 10, 48000), {...full, endSeconds: 7, loopEndSeconds: 7});
  assert.deepEqual(full, {startSeconds: 0, endSeconds: 10, loopStartSeconds: 0, loopEndSeconds: 10});
});

test('trimming beyond a loop moves the entire loop inside the new playback range', () => {
  const right = adjustRanges('startSeconds', 8.5, ranges, 10, 48000);
  assert.equal(right.startSeconds, 8.5);
  assert.equal(right.loopStartSeconds, 8.5);
  assert.ok(right.loopEndSeconds > right.loopStartSeconds && right.loopEndSeconds <= right.endSeconds);
  const left = adjustRanges('endSeconds', 1.5, ranges, 10, 48000);
  assert.equal(left.endSeconds, 1.5);
  assert.equal(left.loopEndSeconds, 1.5);
  assert.ok(left.loopStartSeconds >= left.startSeconds && left.loopStartSeconds < left.loopEndSeconds);
});

test('a rejected edit restores the previous range and sends only numeric boundaries', () => {
  const previousWindow = globalThis.window;
  globalThis.window = {devicePixelRatio: 1};
  try {
    const context = new Proxy({}, {get: () => () => {}});
    const canvas = {addEventListener() {}, getBoundingClientRect: () => ({left: 0, width: 100, height: 100}), getContext: () => context};
    const field = {value: 'startSeconds', disabled: false, addEventListener() {}};
    const sample = {duration: 10, sampleRate: 48000, length: 2, numberOfChannels: 1, getChannelData: () => new Float32Array([0, .5])};
    let received;
    const view = new WaveformView(canvas, field, value => { received = value; return false; });
    view.setZone({buffer: sample, ...ranges});
    view.move({clientX: 40});
    assert.deepEqual(received, {...ranges, startSeconds: 4, loopStartSeconds: 4});
    for (const name of Object.keys(ranges)) assert.equal(view.zone[name], ranges[name]);
  } finally { globalThis.window = previousWindow; }
});

test('sub-sample loops remain editable without crossing their edges', () => {
  const r = {startSeconds: 0, endSeconds: 1, loopStartSeconds: .000001, loopEndSeconds: .000002};
  const left = adjustRanges('loopStartSeconds', 1, r, 1, 48000);
  assert.ok(left.loopStartSeconds > r.loopStartSeconds && left.loopStartSeconds < r.loopEndSeconds);
  const right = adjustRanges('loopEndSeconds', 0, r, 1, 48000);
  assert.ok(right.loopEndSeconds > r.loopStartSeconds && right.loopEndSeconds < r.loopEndSeconds);
});

test('overview represents signed peaks from both channels for short files', () => {
  const channels = [new Float32Array([0, .5, -.25, 0]), new Float32Array([-.5, 0, 0, 1])];
  const peaks = computePeaks({length: 4, numberOfChannels: 2, getChannelData: i => channels[i]});
  assert.deepEqual([...peaks], [-.5, 0, 0, .5, -.25, 0, 0, 1]);
});

test('overview bounds work for very long samples and clamps corrupt numeric values', () => {
  let reads = 0;
  const channel = new Proxy({}, {get: () => { reads++; return reads % 2 ? Infinity : 2; }});
  const peaks = computePeaks({length: 100_000_000, numberOfChannels: 2, getChannelData: () => channel});
  assert.equal(peaks.length, 1280);
  assert.ok(reads <= 640 * 64 * 2 * 3);
  assert.ok([...peaks].every(n => n >= -1 && n <= 1));
});
