import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectWav, MAX_DECODED_SAMPLE_BYTES, MAX_DECODED_TOTAL_BYTES } from '../renderer/wav-guard.js';

function chunk(name, bytes) {
  const result = Buffer.alloc(8 + bytes.length + (bytes.length & 1));
  result.write(name, 0, 'ascii'); result.writeUInt32LE(bytes.length, 4); bytes.copy(result, 8);
  return result;
}
function makeWav({ format = 1, channels = 1, rate = 48000, bits = 16, frames = 4, ext = false, extraChunks = [] } = {}) {
  const f = Buffer.alloc(ext ? 40 : 16), align = channels * bits / 8;
  f.writeUInt16LE(ext ? 0xfffe : format, 0); f.writeUInt16LE(channels, 2); f.writeUInt32LE(rate, 4);
  f.writeUInt32LE(rate * align, 8); f.writeUInt16LE(align, 12); f.writeUInt16LE(bits, 14);
  if (ext) { f.writeUInt16LE(22, 16); f.writeUInt16LE(bits, 18); f.writeUInt32LE(format, 24); Buffer.from([0,0,0x10,0,0x80,0,0,0xaa,0,0x38,0x9b,0x71]).copy(f,28); }
  const chunks = Buffer.concat([chunk('fmt ', f), ...extraChunks, chunk('data', Buffer.alloc(frames * align))]);
  const result = Buffer.alloc(12 + chunks.length); result.write('RIFF',0); result.writeUInt32LE(result.length - 8,4); result.write('WAVE',8); chunks.copy(result,12);
  return result;
}
const array = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

test('reads actual demo WAV and estimates resampled float32 output conservatively', async () => {
  const demo = await readFile(new URL('../示例素材/示例-C4.wav', import.meta.url));
  const info = inspectWav(array(demo), 48000);
  assert.equal(info.frames, 96000); assert.equal(info.channels, 1); assert.equal(info.bitsPerSample, 16);
  assert.equal(info.estimatedBytes, (96000 + 1) * 4);
});

test('supports PCM bit depths, float, extensible GUIDs and odd padded metadata', () => {
  for (const bits of [8,16,24,32]) for (const ext of [false,true]) {
    const b = makeWav({ bits, channels: 2, rate: 44100, frames: 11, ext, extraChunks: [chunk('JUNK', Buffer.from([7]))] });
    const info = inspectWav(array(b), 48000);
    assert.equal(info.frames, 11); assert.equal(info.estimatedBytes, (Math.ceil(11 * 48000 / 44100) + 1) * 8);
  }
  for (const ext of [false,true]) assert.equal(inspectWav(array(makeWav({format:3,bits:32,ext})),48000).format,3);
});

test('rejects malformed RIFF chunks and unsupported format variants', () => {
  const base = makeWav();
  const cases = [];
  const mutate = fn => { const b=Buffer.from(base); fn(b); cases.push(b); };
  mutate(b => b.write('RIFX',0));
  mutate(b => b.writeUInt32LE(b.length,4));
  mutate(b => b.writeUInt32LE(0xffffffff,16));
  mutate(b => b.writeUInt16LE(6,20));
  mutate(b => b.writeUInt16LE(3,22));
  mutate(b => b.writeUInt32LE(7999,24));
  mutate(b => b.writeUInt16LE(1,32));
  mutate(b => b.writeUInt16LE(12,34));
  mutate(b => b.writeUInt32LE(3,40));
  mutate(b => b.writeUInt32LE(0,40));
  const invalidGuid = makeWav({ext:true}); invalidGuid[12+8+28]=1; cases.push(invalidGuid);
  const badFloat = makeWav({format:3,bits:16}); cases.push(badFloat);
  const pad = makeWav({bits:8,frames:3}); cases.push(pad.subarray(0,pad.length-1));
  for (const item of cases) assert.throws(() => inspectWav(array(item),48000));
  assert.throws(() => inspectWav(new ArrayBuffer(0),48000));
  assert.throws(() => inspectWav(array(base),0));
});

test('limits can be enforced before decoder allocation even with a small file', () => {
  const lowRate = makeWav({bits:8,rate:8000,frames: 1_500_000});
  const info = inspectWav(array(lowRate),192000);
  assert.ok(info.estimatedBytes > MAX_DECODED_SAMPLE_BYTES);
  assert.equal(MAX_DECODED_TOTAL_BYTES, 256 * 1024 * 1024);
});
