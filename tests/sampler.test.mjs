import test from 'node:test';
import assert from 'node:assert/strict';
import { SamplerEngine, parseMidiMessage } from '../renderer/sampler.js';

class Param {
  constructor() { this.value = 1; this.events = []; }
  setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); }
  linearRampToValueAtTime(value, time) { this.value = value; this.events.push(['ramp', value, time]); }
  cancelScheduledValues(time) { this.events.push(['cancel', time]); }
}
class Node {
  connect(target) { this.target = target; }
  disconnect() { this.disconnected = true; this.target = undefined; }
}
class Gain extends Node { constructor() { super(); this.gain = new Param(); } }
class Filter extends Node { constructor() { super(); this.frequency = new Param(); this.Q = new Param(); } }
class Source extends Node {
  constructor() { super(); this.playbackRate = new Param(); this.stops = []; }
  start(...args) { this.started = args[0]; this.startArgs = args; }
  stop(time) { this.stops.push(time); }
  finish() { this.onended?.(); }
}
class Context {
  constructor() { this.currentTime = 0; this.destination = {}; this.sources = []; this.decodes = []; }
  createGain() { return new Gain(); }
  createBiquadFilter() { return new Filter(); }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  decodeAudioData(data) { return new Promise((resolve, reject) => this.decodes.push({ data, resolve, reject })); }
}
const sample = { duration: 1, sampleRate: 44100, numberOfChannels: 2, length: 44100 };
async function ready() {
  const context = new Context();
  const engine = new SamplerEngine(context);
  const loading = engine.load(new ArrayBuffer(8));
  context.decodes[0].resolve(sample);
  const info = await loading;
  return { context, engine, info };
}

test('metadata, pitch, polyphony, repeated notes and release during attack', async () => {
  const { context, engine, info } = await ready();
  assert.deepEqual(info, { duration: 1, sampleRate: 44100, channels: 2, frames: 44100 });
  engine.setParameters({ rootNote: 60, attackMs: 200, releaseMs: 100, gainDb: -6, loop: true });
  engine.noteOn(60, 127);
  engine.noteOn(72, 64);
  engine.noteOn(60, 100);
  assert.equal(engine.voices.size, 3);
  assert.equal(context.sources[0].playbackRate.value, 1);
  assert.equal(context.sources[1].playbackRate.value, 2);
  assert.equal(context.sources[0].loop, true);
  context.currentTime = 0.05;
  engine.noteOff(60);
  assert.equal(context.sources[0].stops[0], 0.15000000000000002);
  assert.equal(context.sources[2].stops.length, 1);
  assert.equal(context.sources[1].stops.length, 0);
  const voice = [...engine.voices][0];
  assert.ok(Math.abs(voice.gain.gain.events.at(-2)[1] - 0.25) < 1e-8);
  context.sources[0].finish();
  assert.equal(engine.voices.size, 2);
  assert.equal(context.sources[0].disconnected, true);
  engine.allNotesOff();
  assert.equal(context.sources[1].stops.length, 1);
});

test('new sample silences prior voices and failed decode keeps old sample', async () => {
  const { context, engine } = await ready();
  engine.noteOn(60);
  const failed = engine.load(new ArrayBuffer(4));
  context.decodes[1].reject(new Error('bad WAV'));
  await assert.rejects(failed, /bad WAV/);
  assert.equal(engine.buffer, sample);
  assert.equal(engine.voices.size, 1);
  const pending = engine.load(new ArrayBuffer(4));
  const next = { ...sample, duration: 2, length: 88200 };
  context.decodes[2].resolve(next);
  await pending;
  assert.equal(engine.voices.size, 0);
  assert.equal(context.sources[0].stops.length, 1);
  assert.equal(engine.buffer, next);
});

test('only latest async load wins and dispose invalidates pending loads', async () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  const first = engine.load(new ArrayBuffer(3));
  const second = engine.load(new ArrayBuffer(4));
  context.decodes[1].resolve(sample);
  await second;
  context.decodes[0].resolve(sample);
  await assert.rejects(first, { name: 'AbortError' });
  const third = engine.load(new ArrayBuffer(5));
  engine.dispose();
  context.decodes[2].resolve(sample);
  await assert.rejects(third, { name: 'AbortError' });
  assert.equal(engine.buffer, null);
  assert.throws(() => engine.noteOn(60), /disposed/);
  engine.dispose();
});

test('parameter validation is atomic and pitch updates active notes', async () => {
  const { context, engine } = await ready();
  engine.noteOn(72);
  engine.setParameters({ rootNote: 72 });
  assert.equal(context.sources[0].playbackRate.value, 1);
  assert.throws(() => engine.setParameters({ rootNote: 60, gainDb: Infinity }), RangeError);
  assert.equal(engine.parameters.rootNote, 72);
  assert.throws(() => engine.noteOn(128), RangeError);
  await assert.rejects(engine.load(new ArrayBuffer(0)), TypeError);
});

test('MIDI note-on, zero-velocity note-off, channel and malformed messages', () => {
  assert.deepEqual(parseMidiMessage([0x92, 60, 120]), { type: 'noteOn', note: 60, velocity: 120, channel: 2 });
  assert.deepEqual(parseMidiMessage([0x91, 60, 0]), { type: 'noteOff', note: 60, velocity: 0, channel: 1 });
  assert.deepEqual(parseMidiMessage([0x80, 60, 45]), { type: 'noteOff', note: 60, velocity: 45, channel: 0 });
  assert.deepEqual(parseMidiMessage([0xb2, 64, 127]), { type: 'sustain', value: 127, channel: 2 });
  assert.deepEqual(parseMidiMessage([0xb2, 64, 0]), { type: 'sustain', value: 0, channel: 2 });
  assert.equal(parseMidiMessage([0xb2, 64, 128]), null);
  assert.equal(parseMidiMessage([0xb0, 1, 20]), null);
  assert.equal(parseMidiMessage([0x90, 128, 20]), null);
  assert.equal(parseMidiMessage([0x90]), null);
});

test('polyphony is bounded and ended nodes are disconnected', async () => {
  const { context, engine } = await ready();
  for (let i = 0; i < 65; i++) engine.noteOn(i);
  assert.equal(engine.voices.size, 64);
  assert.equal(context.sources[0].disconnected, true);
  engine.dispose();
  assert.equal(engine.voices.size, 0);
  assert.equal(engine.master.disconnected, true);
});

const zone = (id, overrides = {}) => ({ id, buffer: sample, rootNote: 60, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, ...overrides });

test('zone key and velocity limits are inclusive and overlaps layer with independent roots', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  const second = { ...sample, duration: 2 };
  engine.replaceZones([
    zone('low', { keyLow: 48, keyHigh: 60, velocityLow: 1, velocityHigh: 64 }),
    zone('high', { buffer: second, rootNote: 48, keyLow: 60, keyHigh: 72, velocityLow: 64, velocityHigh: 127 }),
  ]);
  engine.noteOn(47, 64);
  engine.noteOn(48, 65);
  assert.equal(context.sources.length, 0);
  engine.noteOn(60, 64);
  assert.equal(context.sources.length, 2);
  assert.equal(context.sources[0].buffer, sample);
  assert.equal(context.sources[1].buffer, second);
  assert.equal(context.sources[0].playbackRate.value, 1);
  assert.equal(context.sources[1].playbackRate.value, 2);
  engine.setParameters({ rootNote: 24 });
  assert.equal(context.sources[0].playbackRate.value, 1);
  assert.equal(context.sources[1].playbackRate.value, 2);
  engine.noteOn(72, 127);
  assert.equal(context.sources.length, 3);
  engine.noteOff(60);
  assert.equal(context.sources[0].stops.length, 1);
  assert.equal(context.sources[1].stops.length, 1);
  assert.equal(context.sources[2].stops.length, 0);
});

test('invalid replacement retains sounding voices and old zones; successful replacement stops them', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  const original = zone('original', { keyLow: 60, keyHigh: 60 });
  engine.replaceZones([original]);
  original.keyLow = 99; // Input objects cannot silently change the active instrument.
  engine.noteOn(60);
  for (const invalid of [
    [zone('same'), zone('same')],
    [zone('bad', { keyLow: 61, keyHigh: 60 })],
    [zone('bad', { velocityLow: 0 })],
    [zone('bad', { rootNote: 128 })],
    [zone('bad', { buffer: null })],
  ]) assert.throws(() => engine.replaceZones(invalid), RangeError);
  assert.equal(context.sources[0].stops.length, 0);
  engine.noteOn(60);
  assert.equal(context.sources.length, 2);
  engine.replaceZones([]);
  assert.equal(engine.voices.size, 0);
  assert.equal(context.sources[0].disconnected, true);
  engine.noteOn(60);
  assert.equal(context.sources.length, 2);
});

test('decoding does not change zones; replacement supersedes an in-flight legacy load', async () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones([zone('first')]);
  const pending = engine.decodeSample(new ArrayBuffer(8));
  context.decodes[0].resolve(sample);
  assert.equal(await pending, sample);
  assert.equal(engine.zones[0].id, 'first');
  const oldLoad = engine.load(new ArrayBuffer(8));
  engine.replaceZones([zone('replacement')]);
  context.decodes[1].resolve(sample);
  await assert.rejects(oldLoad, { name: 'AbortError' });
  assert.equal(engine.zones[0].id, 'replacement');
});

test('overlapping zone voices share the 64 voice limit', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones(Array.from({ length: 65 }, (_, i) => zone(String(i))));
  engine.noteOn(60, 127);
  assert.equal(engine.voices.size, 64);
  assert.equal(context.sources.length, 65);
  assert.equal(context.sources[0].disconnected, true);
});

test('same note from separate inputs releases only that input including every matching layer', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones([
    zone('soft', { velocityLow: 1, velocityHigh: 80 }),
    zone('all'),
    zone('hard', { velocityLow: 81, velocityHigh: 127 }),
  ]);
  engine.noteOn(60, 50, 'keyboard-1');
  engine.noteOn(60, 100, 'midi-1');
  assert.equal(context.sources.length, 4);
  engine.noteOff(60, 'keyboard-1');
  assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 0, 0]);
  engine.noteOn(60, 50, 'keyboard-2');
  engine.noteOff(60, 'keyboard-1'); // A late release cannot end the retrigger.
  assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 0, 0, 0, 0]);
  engine.noteOn(60, 0, 'midi-1'); // MIDI's zero-velocity note-on uses the same identity.
  assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 1, 1, 0, 0]);
  engine.noteOff(60); // Legacy callers can still release every active voice for a note.
  assert.deepEqual(context.sources.map(source => source.stops.length), [1, 1, 1, 1, 1, 1]);
  assert.throws(() => engine.noteOn(60, 100, ''), TypeError);
  assert.throws(() => engine.noteOff(60, null), TypeError);
});

test('ADSR schedules decay and releases from the actual attack, decay or sustain level', () => {
  for (const [elapsed, expected] of [[0.1, 0.5], [0.3, 0.625], [0.6, 0.25]]) {
    const context = new Context();
    const engine = new SamplerEngine(context);
    engine.replaceZones([zone('one')]);
    engine.setParameters({ attackMs: 200, decayMs: 200, sustainLevel: 0.25, releaseMs: 100 });
    engine.noteOn(60, 127);
    const voice = [...engine.voices][0];
    assert.deepEqual(voice.gain.gain.events.slice(0, 3), [
      ['set', 0, 0], ['ramp', 1, 0.2], ['ramp', 0.25, 0.4],
    ]);
    context.currentTime = elapsed;
    engine.noteOff(60);
    assert.ok(Math.abs(voice.gain.gain.events.at(-2)[1] - expected) < 1e-8);
    assert.equal(voice.gain.gain.events.at(-1)[1], 0);
    assert.ok(Math.abs(context.sources[0].stops[0] - (elapsed + 0.1)) < 1e-8);
  }
});

test('instant attack and decay reach sustain immediately and parameter validation is atomic', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones([zone('one')]);
  engine.setParameters({ attackMs: 0, decayMs: 0, sustainLevel: 0.2, releaseMs: 0 });
  engine.noteOn(60, 127);
  context.currentTime = 0.1;
  engine.noteOff(60);
  assert.equal([...engine.voices][0].gain.gain.events.at(-2)[1], 0.2);
  assert.equal(context.sources[0].stops[0], 0.1);
  for (const changes of [{ decayMs: -1 }, { decayMs: Infinity }, { sustainLevel: -0.1 }, { sustainLevel: 1.1 }]) {
    assert.throws(() => engine.setParameters(changes), RangeError);
  }
  assert.equal(engine.parameters.sustainLevel, 0.2);
});

test('sample and loop bounds control playback and changing loop applies to new voices', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones([zone('one', { startSeconds: 0.1, endSeconds: 0.8, loopStartSeconds: 0.3, loopEndSeconds: 0.6 })]);
  engine.noteOn(60, 127);
  assert.deepEqual(context.sources[0].startArgs.slice(0, 2), [0, 0.1]);
  assert.ok(Math.abs(context.sources[0].startArgs[2] - 0.7) < 1e-8);
  assert.equal(context.sources[0].loop, false);
  assert.equal(context.sources[0].loopStart, 0.3);
  assert.equal(context.sources[0].loopEnd, 0.6);
  engine.setParameters({ loop: true });
  assert.equal(context.sources[0].loop, false);
  engine.noteOn(60, 127);
  assert.deepEqual(context.sources[1].startArgs, [0, 0.1]);
  assert.equal(context.sources[1].loop, true);
  engine.setParameters({ loop: false });
  assert.equal(context.sources[1].loop, true);
});

test('invalid boundaries reject a replacement without stopping current voices', () => {
  const context = new Context();
  const engine = new SamplerEngine(context);
  engine.replaceZones([zone('valid')]);
  engine.noteOn(60, 127);
  for (const changes of [
    { startSeconds: -1 }, { startSeconds: 0.5, endSeconds: 0.5 },
    { endSeconds: 1.01 }, { startSeconds: 0.2, loopStartSeconds: 0.1 },
    { loopStartSeconds: 0.5, loopEndSeconds: 0.5 },
    { endSeconds: 0.8, loopEndSeconds: 0.9 }, { loopEndSeconds: NaN },
  ]) assert.throws(() => engine.replaceZones([zone('invalid', changes)]), RangeError);
  assert.equal(context.sources[0].stops.length, 0);
  assert.equal(engine.zones[0].id, 'valid');
  assert.deepEqual([engine.zones[0].startSeconds, engine.zones[0].endSeconds, engine.zones[0].loopStartSeconds, engine.zones[0].loopEndSeconds], [0, 1, 0, 1]);
});


test('lowpass is bypassed by default, updates playing voices and returns to bypass', async () => {
  const { context, engine } = await ready();
  assert.equal(engine.master.target, context.destination);
  assert.equal(engine.filter.target, context.destination);
  assert.equal(engine.filter.type, 'lowpass');
  assert.equal(engine.filter.frequency.value, 12000);
  assert.equal(engine.filter.Q.value, 0.7);
  engine.noteOn(60, 127);
  const voice = [...engine.voices][0];
  assert.equal(voice.gain.target, engine.master);
  context.currentTime = 0.5;
  engine.setParameters({ filterEnabled: true, filterCutoffHz: 500, filterQ: 2 });
  assert.equal(engine.master.target, engine.filter);
  assert.deepEqual(engine.filter.frequency.events.at(-1), ['set', 500, 0.5]);
  assert.deepEqual(engine.filter.Q.events.at(-1), ['set', 2, 0.5]);
  assert.equal(context.sources[0].stops.length, 0);
  engine.setParameters({ filterEnabled: false });
  assert.equal(engine.master.target, context.destination);
  assert.equal(context.sources[0].stops.length, 0);
  engine.dispose();
  assert.equal(engine.filter.disconnected, true);
  assert.equal(engine.master.target, undefined);
});

test('filter parameter validation leaves audio graph and values unchanged on failure', async () => {
  const { engine } = await ready();
  engine.setParameters({ filterEnabled: true, filterCutoffHz: 400, filterQ: 1 });
  const previous = { ...engine.parameters };
  const events = engine.filter.frequency.events.length;
  for (const changes of [
    { filterEnabled: 1 }, { filterCutoffHz: 19 }, { filterCutoffHz: 20001 },
    { filterCutoffHz: NaN }, { filterQ: 0.09 }, { filterQ: 20.01 }, { filterQ: Infinity },
  ]) {
    assert.throws(() => engine.setParameters({ ...changes, filterEnabled: changes.filterEnabled ?? false }), RangeError);
    assert.deepEqual(engine.parameters, previous);
    assert.equal(engine.master.target, engine.filter);
    assert.equal(engine.filter.frequency.events.length, events);
  }
  engine.setParameters({ filterCutoffHz: 20, filterQ: 0.1 });
  engine.setParameters({ filterCutoffHz: 20000, filterQ: 20 });
  assert.equal(engine.filter.frequency.value, 20000);
  assert.equal(engine.filter.Q.value, 20);
  engine.dispose();
});
