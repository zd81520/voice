import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sampler-close-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ args: ['.', `--user-data-dir=${temp}`], env });
try {
  const page = await app.firstWindow();
  // Electron handles beforeunload through will-prevent-unload; do not have
  // Playwright race it by automatically accepting the CDP dialog.
  page.on('dialog', () => {});
  await page.locator('#project-name').fill('未保存修改');
  assert.match(await page.locator('#dirty-status').innerText(), /未保存/);
  await app.evaluate(({ dialog }) => { globalThis.guardResponse = 0; globalThis.guardCalls = 0; dialog.showMessageBoxSync = () => { globalThis.guardCalls++; return globalThis.guardResponse; }; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForTimeout(300);
  assert.equal(await app.evaluate(() => globalThis.guardCalls), 1);
  assert.equal(await page.locator('#project-name').inputValue(), '未保存修改');
  await app.evaluate(() => { globalThis.guardResponse = 1; });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await page.waitForEvent('close', { timeout: 5000 }).catch(() => { if (!page.isClosed()) throw new Error('Window did not close after discard'); });
  console.log('PASS: unsaved close prompts, cancel preserves edits, discard permits close.');
} finally {
  await app.close().catch(() => {});
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  await fs.rm(temp, { recursive: true, force: true });
}
