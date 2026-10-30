import test from 'node:test';
import assert from 'node:assert/strict';
import {zoneGeometry, ZoneMapView} from '../renderer/zone-map-view.js';

class Element {
  constructor(document, tag) { this.ownerDocument = document; this.tag = tag; this.children = []; this.attributes = {}; this.events = {}; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, fn) { this.events[type] = fn; }
  contains(target) { return target === this || this.children.some(child => child.contains(target)); }
  focus() { this.ownerDocument.activeElement = this; }
}
class Document {
  createElement(tag) { return new Element(this, tag); }
  createElementNS(_, tag) { return new Element(this, tag); }
}
const zone = (id, values = {}) => ({id, name: id, rootNote: 60, keyLow: 48, keyHigh: 72, velocityLow: 10, velocityHigh: 110, ...values});
const setup = () => { const doc = new Document(); const host = doc.createElement('div'); const calls = []; return {doc,host,calls,view: new ZoneMapView(host, id => calls.push(id))}; };
const buttons = host => host.children[0].children.filter(child => child.attributes.role === 'button');

test('geometry includes the full MIDI bounds and preserves root outside a key range', () => {
  const all = zoneGeometry(zone('a', {keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, rootNote: 127}));
  assert.equal(all.x, 0); assert.equal(all.y, 0); assert.equal(all.width, 640); assert.equal(all.height, 160); assert.equal(all.rootX, 637.5);
  const one = zoneGeometry(zone('a', {keyLow: 0, keyHigh: 0, velocityLow: 127, velocityHigh: 127, rootNote: 5}));
  assert.equal(one.width, 5); assert.equal(one.y, 0); assert.ok(one.height > 0); assert.ok(one.rootX > one.width);
});

test('empty map is replaced with labeled, selectable overlapping zones and selection renders last', () => {
  const {host,view,calls} = setup();
  view.setZones([], null);
  assert.match(host.children[0].textContent, /添加采样/);
  view.setZones([zone('first'),zone('second')], 'first');
  const items = buttons(host);
  assert.equal(items.length, 2);
  assert.equal(items[0].getAttribute('data-zone-id'), 'second');
  assert.equal(items[1].getAttribute('data-zone-id'), 'first');
  assert.equal(items[1].getAttribute('aria-pressed'), 'true');
  assert.match(items[1].getAttribute('aria-label'), /键位 48 至 72，力度 10 至 110，根音 60/);
  items[0].events.click();
  assert.deepEqual(calls, ['second']);
});

test('keyboard activation supports Enter and Space and focus survives redraw', () => {
  const {doc,host,view,calls} = setup();
  view.setZones([zone('a'),zone('b')], 'a');
  const item = buttons(host).find(button => button.getAttribute('data-zone-id') === 'b');
  assert.equal(item.getAttribute('tabindex'), '0');
  let prevented = 0;
  item.events.keydown({key:'Enter', preventDefault:() => prevented++});
  item.events.keydown({key:' ', preventDefault:() => prevented++});
  item.events.keydown({key:'ArrowLeft', preventDefault:() => prevented++});
  assert.equal(prevented, 2); assert.deepEqual(calls, ['b','b']);
  item.focus(); view.setZones([zone('a'),zone('b')], 'b');
  assert.equal(doc.activeElement.getAttribute('data-zone-id'), 'b');
  assert.equal(doc.activeElement.getAttribute('aria-pressed'), 'true');
});
