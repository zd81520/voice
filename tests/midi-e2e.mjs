import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A fake Web MIDI port drives the same UI handler as a physical controller.
const wav = Buffer.alloc(44 + 48000 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(96000, 40);
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sampler-midi-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(temp, 'profile')}`], env });
  const win = await app.firstWindow();
  await win.locator('#file-input').waitFor({ state: 'attached' });
  const errors = []; win.on('pageerror', error => errors.push(error.message));
  await win.evaluate(() => {
    const port = { id: 'fake', name: '测试键盘', state: 'connected', onmidimessage: null };
    window.fakeMidi = { inputs: new Map([['fake', port]]), onstatechange: null, port };
    Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: async () => window.fakeMidi });
    window.events = { starts: 0, stops: 0, sources: [] };
    const start = AudioBufferSourceNode.prototype.start, stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function(...args) { window.events.starts++; window.events.sources.push(this); return start.apply(this, args); };
    AudioBufferSourceNode.prototype.stop = function(...args) { window.events.stops++; return stop.apply(this, args); };
  });
  await win.locator('#file-input').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav });
  await win.waitForFunction(() => document.querySelector('#sample-status').textContent === '1 / 64');
  await win.locator('#loop').check();
  await win.locator('#enable-audio').click();
  await win.locator('#enable-midi').click();
  await win.locator('#midi-device').selectOption('fake');
  const send = data => win.evaluate(data => window.fakeMidi.port.onmidimessage({ data }), data);
  await win.keyboard.down('z');
  await send([0xb0, 64, 127]); await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 2);
  await send([0xe0, 127, 127]);
  await win.waitForFunction(() => Math.abs(window.events.sources[1].playbackRate.value - 2 ** (2 / 12)) < 0.001);
  assert.equal(await win.evaluate(() => window.events.sources[0].playbackRate.value), 0.5);
  await send([0x80, 60, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, 0);
  await send([0xe0, 0, 0]);
  await win.waitForFunction(() => Math.abs(window.events.sources[1].playbackRate.value - 2 ** (-2 / 12)) < 0.001);
  await send([0x91, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 3);
  assert.equal(await win.evaluate(() => window.events.sources[2].playbackRate.value), 1);
  await send([0x81, 60, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, 1);
  await send([0xb0, 64, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, 2);
  await win.keyboard.up('z');
  assert.equal((await win.evaluate(() => window.events)).stops, 3);
  await send([0xb0, 64, 127]); await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 4);
  await send([0x80, 60, 0]);
  await win.locator('#stop-notes').click();
  assert.equal((await win.evaluate(() => window.events)).stops, 4);
  // The controller has not sent another pedal message: the pedal is still down.
  await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 5);
  await send([0x80, 60, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, 4);
  await win.evaluate(() => window.dispatchEvent(new Event('blur')));
  assert.equal((await win.evaluate(() => window.events)).stops, 5);
  await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 6);
  await send([0x80, 60, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, 5);
  await win.locator('#zone-name').fill('编辑后的采样');
  await win.locator('#apply-zone').click();
  // Replacing zones immediately ends release tails as well as the current note.
  const stoppedAfterReplace = (await win.evaluate(() => window.events)).stops;
  assert(stoppedAfterReplace >= 6);
  await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 7);
  await win.waitForFunction(() => Math.abs(window.events.sources[6].playbackRate.value - 2 ** (-2 / 12)) < 0.001);
  await send([0x80, 60, 0]);
  assert.equal((await win.evaluate(() => window.events)).stops, stoppedAfterReplace);
  await win.evaluate(() => { window.fakeMidi.port.state = 'disconnected'; window.fakeMidi.onstatechange(); });
  assert.equal((await win.evaluate(() => window.events)).stops, stoppedAfterReplace + 1);
  assert.match(await win.locator('#midi-status').innerText(), /未发现 MIDI/);
  await win.evaluate(() => { window.fakeMidi.port.state = 'connected'; window.fakeMidi.onstatechange(); });
  await win.locator('#midi-device').selectOption('fake');
  await send([0x90, 60, 100]);
  await win.waitForFunction(() => window.events.starts === 8);
  assert.equal(await win.evaluate(() => window.events.sources[7].playbackRate.value), 1);
  await send([0x80, 60, 0]);
  win.once('dialog', dialog => dialog.accept());
  await win.locator('#new-project').click();
  assert.equal(await win.locator('#sample-status').innerText(), '0 / 64');
  assert.deepEqual(errors, []);
  console.log('PASS: MIDI sustain and pitch bend, channel isolation, keyboard independence and disconnect through the application UI.');
} finally {
  if (app) {
    // The test can fail with an unsaved project; tear down without triggering its confirmation dialog.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => {});
    await app.close();
  }
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  await fs.rm(temp, { recursive: true, force: true });
}
