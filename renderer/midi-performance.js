/** Track physical MIDI key presses and pedal-held voices independently per channel. */
export class MidiPerformance {
  constructor(press, release, pitchBend = () => {}) {
    this.press = press;
    this.release = release;
    this.pitchBend = pitchBend;
    this.sequence = 0;
    this.keys = new Map();
    this.pedals = new Set();
    this.sustained = new Map();
    this.pitchBends = new Map();
  }

  handle(message) {
    const { channel } = message;
    if (message.type === 'pitchBend') {
      this.pitchBends.set(channel, message.value);
      this.pitchBend(channel, message.value);
      return;
    }
    if (message.type === 'sustain') {
      if (message.value >= 64) this.pedals.add(channel);
      else {
        this.pedals.delete(channel);
        const voices = this.sustained.get(channel);
        this.sustained.delete(channel);
        if (voices) for (const source of voices) this.release(source);
      }
      return;
    }
    const key = `${channel}:${message.note}`;
    if (message.type === 'noteOn') {
      const source = `midi:${channel}:${message.note}:${++this.sequence}`;
      const voices = this.keys.get(key) ?? [];
      voices.push(source);
      this.keys.set(key, voices);
      this.press(source, message.note, message.velocity, channel);
    } else if (message.type === 'noteOff') {
      const voices = this.keys.get(key);
      if (!voices?.length) return;
      const source = voices.shift();
      if (!voices.length) this.keys.delete(key);
      if (this.pedals.has(channel)) {
        const held = this.sustained.get(channel) ?? new Set();
        held.add(source);
        this.sustained.set(channel, held);
      } else this.release(source);
    }
  }

  getPitchBend(channel) { return this.pitchBends.get(channel) ?? 8192; }

  /** Release all notes while retaining the connected controller's pedal state. */
  releaseNotes() {
    for (const voices of this.keys.values()) for (const source of voices) this.release(source);
    for (const voices of this.sustained.values()) for (const source of voices) this.release(source);
    this.keys.clear();
    this.sustained.clear();
  }

  /** A detached controller no longer owns any notes or pedal state. */
  reset() {
    this.releaseNotes();
    this.pedals.clear();
    for (const channel of this.pitchBends.keys()) this.pitchBend(channel, 8192);
    this.pitchBends.clear();
  }
}
