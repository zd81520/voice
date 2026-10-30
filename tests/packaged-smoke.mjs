import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

const wav = Buffer.alloc(44 + 4800 * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(9600, 40);
for (let i = 0; i < 4800; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 12000), 44 + i * 2);

const executablePath = path.resolve('release/win-unpacked/采样工作台.exe');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath, env });
try {
  const window = await app.firstWindow();
  const errors = []; window.on('pageerror', error => errors.push(error.message));
  await window.locator('h1').waitFor();
  await window.locator('#file-input').setInputFiles({ name: 'test.wav', mimeType: 'audio/wav', buffer: wav });
  await window.waitForFunction(() => document.querySelector('#sample-status').textContent === '1 / 64');
  assert.match(await window.locator('#zone-list').innerText(), /test\.wav/);
  await window.waitForFunction(() => !document.querySelector('#enable-audio').disabled);
  if ((await window.locator('#enable-audio').innerText()) !== '暂停音频') await window.locator('#enable-audio').click();
  await window.waitForFunction(() => !document.querySelector('#enable-audio').disabled && document.querySelector('#enable-audio').textContent === '暂停音频');
  await window.keyboard.down('z');
  await window.waitForFunction(() => document.querySelector('[aria-label="C3"]').classList.contains('active'));
  await window.keyboard.up('z');
  await window.waitForFunction(() => !document.querySelector('[aria-label="C3"]').classList.contains('active'));
  await window.locator('#enable-midi').click();
  await window.waitForFunction(() => !document.querySelector('#midi-status').textContent.includes('未连接'));
  const midiStatus = await window.locator('#midi-status').innerText();
  assert(!midiStatus.includes('权限被拒绝') && !midiStatus.includes('not granted'), midiStatus);
  assert.deepEqual(errors, []);
  await window.screenshot({ path: path.join(os.tmpdir(), 'sample-workbench-preview.png') });
  console.log('Packaged app passed WAV import, audio start, keyboard press/release, MIDI permission and renderer checks.');
  console.log('MIDI status:', midiStatus);
  // Exercise unsaved-close guard without Playwright racing the native prompt.
  window.on('dialog', () => {});
  await app.evaluate(({ dialog }) => { dialog.showMessageBoxSync = () => 1; });
} finally { await app.close(); }
