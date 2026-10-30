const NS = 'http://www.w3.org/2000/svg';
const WIDTH = 640;
const HEIGHT = 160;

/** Map the inclusive MIDI key and velocity ranges to a 640 × 160 plot. */
export function zoneGeometry(zone) {
  return {
    x: zone.keyLow * WIDTH / 128,
    y: (127 - zone.velocityHigh) * HEIGHT / 127,
    width: (zone.keyHigh - zone.keyLow + 1) * WIDTH / 128,
    height: (zone.velocityHigh - zone.velocityLow + 1) * HEIGHT / 127,
    rootX: (zone.rootNote + 0.5) * WIDTH / 128,
  };
}

/** A compact MIDI key × velocity map; the adjacent zone list remains usable for overlapping zones. */
export class ZoneMapView {
  constructor(element, onSelect) {
    this.element = element;
    this.onSelect = onSelect;
    this.document = element.ownerDocument;
  }

  setZones(zones, selectedId) {
    const doc = this.document;
    const focusedId = this.element.contains(doc.activeElement) ? doc.activeElement.getAttribute('data-zone-id') : null;
    if (!zones.length) {
      const empty = doc.createElement('p');
      empty.className = 'zone-map-empty';
      empty.textContent = '添加采样后，这里会显示各音区的键位和力度范围。';
      this.element.replaceChildren(empty);
      return;
    }
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '-35 -12 685 205');
    svg.setAttribute('class', 'zone-map-svg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', '音区键位与力度映射图');
    const add = (tag, attrs, parent = svg, content) => {
      const item = doc.createElementNS(NS, tag);
      for (const [key, value] of Object.entries(attrs)) item.setAttribute(key, String(value));
      if (content !== undefined) item.textContent = content;
      parent.append(item);
      return item;
    };
    add('rect', {x: 0, y: 0, width: WIDTH, height: HEIGHT, class: 'zone-map-background'});
    for (const note of [0, 32, 64, 96, 127]) {
      const x = (note + 0.5) * WIDTH / 128;
      add('line', {x1: x, y1: 0, x2: x, y2: HEIGHT, class: 'zone-map-grid'});
      add('text', {x, y: HEIGHT + 16, 'text-anchor': 'middle', class: 'zone-map-axis'}, svg, String(note));
    }
    for (const [velocity, y] of [[127, 0], [64, HEIGHT / 2], [1, HEIGHT]]) {
      add('line', {x1: 0, y1: y, x2: WIDTH, y2: y, class: 'zone-map-grid'});
      add('text', {x: -7, y: y + 4, 'text-anchor': 'end', class: 'zone-map-axis'}, svg, String(velocity));
    }
    // Draw the selected zone last, so it remains visible where zones overlap.
    const ordered = [...zones.filter(zone => zone.id !== selectedId), ...zones.filter(zone => zone.id === selectedId)];
    let restoreFocus = null;
    for (const zone of ordered) {
      const g = zoneGeometry(zone);
      const label = `${zone.name}，键位 ${zone.keyLow} 至 ${zone.keyHigh}，力度 ${zone.velocityLow} 至 ${zone.velocityHigh}，根音 ${zone.rootNote}`;
      const item = add('g', {class: `zone-map-zone${zone.id === selectedId ? ' selected' : ''}`, role: 'button', tabindex: 0, 'aria-label': label, 'aria-pressed': String(zone.id === selectedId), 'data-zone-id': zone.id});
      if (zone.id === focusedId) restoreFocus = item;
      add('title', {}, item, label);
      add('rect', {x: g.x, y: g.y, width: g.width, height: g.height, rx: 1, class: 'zone-map-range'}, item);
      // A root note may lie outside the zone's range; the marker still shows its true position.
      add('line', {x1: g.rootX, y1: g.y, x2: g.rootX, y2: g.y + g.height, class: 'zone-map-root', 'pointer-events': 'none'}, item);
      const select = () => this.onSelect(zone.id);
      item.addEventListener('click', select);
      item.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
      });
    }
    this.element.replaceChildren(svg);
    if (restoreFocus) restoreFocus.focus();
  }
}
