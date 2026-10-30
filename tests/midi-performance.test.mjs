import test from 'node:test';
import assert from 'node:assert/strict';
import { MidiPerformance } from '../renderer/midi-performance.js';

function fixture() {
  const active = new Map(), releases = [];
  const midi = new MidiPerformance((id, note, velocity) => active.set(id, { note, velocity }), id => {
    releases.push(id); active.delete(id);
  });
  const on = (channel, note, velocity = 100) => midi.handle({ type: 'noteOn', channel, note, velocity });
  const off = (channel, note) => midi.handle({ type: 'noteOff', channel, note });
  const pedal = (channel, value) => midi.handle({ type: 'sustain', channel, value });
  return { midi, active, releases, on, off, pedal };
}

test('sustain holds released voices only on its channel and releases them at the 63 threshold', () => {
  const { active, on, off, pedal } = fixture();
  pedal(0, 64);
  on(0, 60); on(1, 60); on(0, 62);
  off(0, 60); off(1, 60);
  assert.deepEqual([...active.values()].map(v => v.note), [60, 62]);
  pedal(1, 0);
  assert.equal(active.size, 2);
  pedal(0, 63);
  assert.deepEqual([...active.values()].map(v => v.note), [62]);
  off(0, 62);
  assert.equal(active.size, 0);
});

test('repeated notes have independent identities and FIFO releases under sustain', () => {
  const { active, on, off, pedal } = fixture();
  pedal(3, 127);
  on(3, 60, 40); on(3, 60, 100);
  const ids = [...active.keys()];
  off(3, 60);
  pedal(3, 0);
  assert.equal(active.has(ids[0]), false);
  assert.equal(active.has(ids[1]), true);
  off(3, 60);
  off(3, 60);
  assert.equal(active.size, 0);
});

test('reset releases pending, physically held, and sustained notes and clears pedal state', () => {
  const { midi, active, releases, on, off, pedal } = fixture();
  pedal(0, 127); on(0, 60); off(0, 60); on(1, 61);
  midi.reset();
  assert.equal(active.size, 0);
  assert.equal(releases.length, 2);
  midi.reset();
  assert.equal(releases.length, 2);
  on(0, 62); off(0, 62);
  assert.equal(active.size, 0);
});

test('releasing notes retains connected pedal state until release or detach', () => {
  const { midi, active, on, off, pedal } = fixture();
  pedal(0, 127); on(0, 60); off(0, 60); on(1, 60);
  midi.releaseNotes();
  assert.equal(active.size, 0);
  on(0, 62); off(0, 62);
  on(1, 62); off(1, 62);
  assert.deepEqual([...active.values()].map(v => v.note), [62]);
  pedal(0, 0);
  assert.equal(active.size, 0);
  pedal(0, 127);
  midi.reset();
  on(0, 62); off(0, 62);
  assert.equal(active.size, 0);
});

test('a pending asynchronous press is cancelled by pedal-up or reset, but not by note-off under pedal', async () => {
  let resume;
  const pending = new Map(), sounded = [];
  const midi = new MidiPerformance(async source => {
    const record = {};
    pending.set(source, record);
    await new Promise(resolve => { resume = resolve; });
    if (pending.get(source) === record) sounded.push(source);
  }, source => pending.delete(source));
  midi.handle({ type: 'sustain', channel: 0, value: 127 });
  midi.handle({ type: 'noteOn', channel: 0, note: 60, velocity: 100 });
  midi.handle({ type: 'noteOff', channel: 0, note: 60 });
  assert.equal(pending.size, 1);
  midi.handle({ type: 'sustain', channel: 0, value: 0 });
  resume(); await Promise.resolve();
  assert.deepEqual(sounded, []);
  midi.handle({ type: 'noteOn', channel: 0, note: 60, velocity: 100 });
  midi.reset(); resume(); await Promise.resolve();
  assert.deepEqual(sounded, []);
  midi.handle({ type: 'sustain', channel: 0, value: 127 });
  midi.handle({ type: 'noteOn', channel: 0, note: 60, velocity: 100 });
  midi.handle({ type: 'noteOff', channel: 0, note: 60 });
  resume(); await Promise.resolve();
  assert.equal(sounded.length, 1);
  midi.handle({ type: 'sustain', channel: 0, value: 0 });
  assert.equal(pending.size, 0);
});

test('pitch bend is retained per channel through releases and reset on device detach', () => {
  const bends = [], presses = [], releases = [];
  const midi = new MidiPerformance((...args) => presses.push(args), id => releases.push(id), (channel, value) => bends.push([channel, value]));
  midi.handle({ type: 'pitchBend', channel: 2, value: 16383 });
  midi.handle({ type: 'pitchBend', channel: 3, value: 0 });
  midi.handle({ type: 'sustain', channel: 2, value: 127 });
  midi.handle({ type: 'noteOn', channel: 2, note: 60, velocity: 100 });
  midi.handle({ type: 'noteOff', channel: 2, note: 60 });
  assert.equal(presses[0][3], 2);
  assert.equal(midi.getPitchBend(2), 16383);
  assert.equal(midi.getPitchBend(1), 8192);
  midi.releaseNotes();
  assert.equal(releases.length, 1);
  assert.equal(midi.getPitchBend(2), 16383);
  midi.reset();
  assert.equal(midi.getPitchBend(2), 8192);
  assert.equal(midi.getPitchBend(3), 8192);
  assert.deepEqual(bends, [[2, 16383], [3, 0], [2, 8192], [3, 8192]]);
  midi.reset();
  assert.equal(bends.length, 4);
});

test('a pending asynchronous MIDI note sees the latest wheel position when audio resumes', async () => {
  let resume;
  const pending = new Map(), sounded = [];
  const midi = new MidiPerformance(async (source, note, velocity, channel) => {
    const record = {};
    pending.set(source, record);
    await new Promise(resolve => { resume = resolve; });
    if (pending.get(source) === record) sounded.push([channel, midi.getPitchBend(channel)]);
  }, source => pending.delete(source));
  midi.handle({ type: 'noteOn', channel: 1, note: 60, velocity: 100 });
  midi.handle({ type: 'pitchBend', channel: 1, value: 0 });
  resume(); await Promise.resolve();
  assert.deepEqual(sounded, [[1, 0]]);
  midi.handle({ type: 'noteOn', channel: 2, note: 61, velocity: 100 });
  midi.reset();
  resume(); await Promise.resolve();
  assert.deepEqual(sounded, [[1, 0]]);
});
