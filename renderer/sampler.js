/** Parse the MIDI messages used by the sampler. */
export function parseMidiMessage(data) {
  if (!data || data.length < 3) return null;
  const [status, note, velocity] = data;
  if (![status, note, velocity].every(Number.isInteger) || status < 0x80 || status > 0xef || note < 0 || note > 127 || velocity < 0 || velocity > 127) return null;
  const kind = status & 0xf0;
  if (kind === 0x90 && velocity > 0) return { type: 'noteOn', note, velocity, channel: status & 0x0f };
  if (kind === 0x80 || (kind === 0x90 && velocity === 0)) return { type: 'noteOff', note, velocity, channel: status & 0x0f };
  if (kind === 0xb0 && note === 64) return { type: 'sustain', value: velocity, channel: status & 0x0f };
  return null;
}

/** Polyphonic sample playback. Caller owns/resumes/closes the AudioContext. */
export class SamplerEngine {
  constructor(audioContext) {
    if (!audioContext || typeof audioContext.createGain !== 'function') throw new TypeError('A valid AudioContext is required');
    this.context = audioContext;
    this.master = audioContext.createGain();
    this.master.connect(audioContext.destination);
    this.filter = audioContext.createBiquadFilter();
    this.filter.type = 'lowpass';
    this.filter.connect(audioContext.destination);
    this.parameters = { rootNote: 60, attackMs: 5, decayMs: 0, sustainLevel: 1, releaseMs: 100, gainDb: -6, loop: false, filterEnabled: false, filterCutoffHz: 12000, filterQ: 0.7 };
    this.filter.frequency.value = this.parameters.filterCutoffHz;
    this.filter.Q.value = this.parameters.filterQ;
    this.master.gain.value = 10 ** (this.parameters.gainDb / 20);
    this.buffer = null;
    this.zones = [];
    this.voices = new Set();
    this._loadGeneration = 0;
    this._disposed = false;
  }

  /** Decode without changing the playable instrument. */
  async decodeSample(arrayBuffer) {
    this._ensureLive();
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength === 0) throw new TypeError('A nonempty ArrayBuffer is required');
    const decoded = await this.context.decodeAudioData(arrayBuffer.slice(0));
    this._ensureLive();
    if (!decoded || !Number.isFinite(decoded.duration) || decoded.duration <= 0 || !Number.isInteger(decoded.numberOfChannels) || decoded.numberOfChannels < 1 || !Number.isInteger(decoded.length) || decoded.length < 1) throw new Error('Decoded audio is empty');
    return decoded;
  }

  /** Atomically replace the instrument after validating every zone. */
  replaceZones(zones) {
    this._ensureLive();
    if (!Array.isArray(zones)) throw new TypeError('Zones must be an array');
    const ids = new Set();
    const next = zones.map(zone => {
      if (!zone || typeof zone !== 'object' || typeof zone.id !== 'string' || !zone.id || ids.has(zone.id)) throw new RangeError('Zone ids must be unique nonempty strings');
      const { id, buffer, rootNote, keyLow, keyHigh, velocityLow, velocityHigh } = zone;
      if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || !Number.isInteger(buffer.length) || buffer.length < 1 || !Number.isInteger(buffer.numberOfChannels) || buffer.numberOfChannels < 1 ||
          ![rootNote, keyLow, keyHigh, velocityLow, velocityHigh].every(Number.isInteger) ||
          rootNote < 0 || rootNote > 127 || keyLow < 0 || keyHigh > 127 || keyLow > keyHigh ||
          velocityLow < 1 || velocityHigh > 127 || velocityLow > velocityHigh) throw new RangeError('Invalid zone');
      const startSeconds = zone.startSeconds ?? 0;
      const endSeconds = zone.endSeconds ?? buffer.duration;
      const loopStartSeconds = zone.loopStartSeconds ?? startSeconds;
      const loopEndSeconds = zone.loopEndSeconds ?? endSeconds;
      if (![startSeconds, endSeconds, loopStartSeconds, loopEndSeconds].every(Number.isFinite) ||
          startSeconds < 0 || startSeconds >= endSeconds || endSeconds > buffer.duration ||
          loopStartSeconds < startSeconds || loopStartSeconds >= loopEndSeconds || loopEndSeconds > endSeconds) {
        throw new RangeError('Invalid sample or loop boundaries');
      }
      ids.add(id);
      return { id, buffer, rootNote, keyLow, keyHigh, velocityLow, velocityHigh, startSeconds, endSeconds, loopStartSeconds, loopEndSeconds };
    });
    this._loadGeneration++;
    this._stopImmediately();
    this.zones = next;
    this.buffer = null;
  }

  /** Legacy single-sample loading: latest load wins and failure retains the old instrument. */
  async load(arrayBuffer) {
    this._ensureLive();
    const generation = ++this._loadGeneration;
    let decoded;
    try { decoded = await this.decodeSample(arrayBuffer); }
    catch (error) {
      if (generation !== this._loadGeneration || this._disposed) throw this._superseded();
      throw error;
    }
    if (generation !== this._loadGeneration || this._disposed) throw this._superseded();
    this._stopImmediately();
    this.buffer = decoded;
    this.zones = [{ id: '__legacy__', buffer: decoded, rootNote: this.parameters.rootNote, keyLow: 0, keyHigh: 127, velocityLow: 1, velocityHigh: 127, startSeconds: 0, endSeconds: decoded.duration, loopStartSeconds: 0, loopEndSeconds: decoded.duration, legacy: true }];
    return { duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, frames: decoded.length };
  }

  setParameters(changes) {
    this._ensureLive();
    if (!changes || typeof changes !== 'object') throw new TypeError('Parameters must be an object');
    const next = { ...this.parameters, ...changes };
    if (!Number.isInteger(next.rootNote) || next.rootNote < 0 || next.rootNote > 127 ||
        !Number.isFinite(next.attackMs) || next.attackMs < 0 || next.attackMs > 10000 ||
        !Number.isFinite(next.decayMs) || next.decayMs < 0 || next.decayMs > 10000 ||
        !Number.isFinite(next.sustainLevel) || next.sustainLevel < 0 || next.sustainLevel > 1 ||
        !Number.isFinite(next.releaseMs) || next.releaseMs < 0 || next.releaseMs > 10000 ||
        !Number.isFinite(next.gainDb) || next.gainDb < -96 || next.gainDb > 12 || typeof next.loop !== 'boolean' ||
        typeof next.filterEnabled !== 'boolean' || !Number.isFinite(next.filterCutoffHz) || next.filterCutoffHz < 20 || next.filterCutoffHz > 20000 ||
        !Number.isFinite(next.filterQ) || next.filterQ < 0.1 || next.filterQ > 20) {
      throw new RangeError('Invalid sampler parameters');
    }
    const wasFilterEnabled = this.parameters.filterEnabled;
    this.parameters = next;
    this.filter.frequency.setValueAtTime(next.filterCutoffHz, this.context.currentTime);
    this.filter.Q.setValueAtTime(next.filterQ, this.context.currentTime);
    if (next.filterEnabled !== wasFilterEnabled) {
      this.master.disconnect();
      this.master.connect(next.filterEnabled ? this.filter : this.context.destination);
    }
    this.master.gain.setValueAtTime(10 ** (next.gainDb / 20), this.context.currentTime);
    // Explicit zone roots stay independent of the legacy single-sample root.
    for (const zone of this.zones) if (zone.legacy) zone.rootNote = next.rootNote;
    for (const voice of this.voices) {
      if (!voice.releasing) {
        voice.source.playbackRate.setValueAtTime(2 ** ((voice.note - (voice.zone.legacy ? next.rootNote : voice.zone.rootNote)) / 12), this.context.currentTime);
      }
    }
  }

  noteOn(note, velocity = 100, voiceId = undefined) {
    this._ensureLive();
    if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isInteger(velocity) || velocity < 0 || velocity > 127) throw new RangeError('Invalid MIDI note or velocity');
    if (voiceId !== undefined && (typeof voiceId !== 'string' || !voiceId)) throw new TypeError('Voice id must be a nonempty string');
    if (velocity === 0) { this.noteOff(note, voiceId); return; }
    const matches = this.zones.filter(zone => note >= zone.keyLow && note <= zone.keyHigh && velocity >= zone.velocityLow && velocity <= zone.velocityHigh);
    for (const zone of matches) {
      // Bound native node count and retire the oldest voice when polyphony is full.
      if (this.voices.size >= 64) this._endNow(this.voices.values().next().value);
      const now = this.context.currentTime;
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const peak = velocity / 127;
      const attackSeconds = this.parameters.attackMs / 1000;
      const decaySeconds = this.parameters.decayMs / 1000;
      const sustain = peak * this.parameters.sustainLevel;
      source.buffer = zone.buffer;
      source.loop = this.parameters.loop;
      source.loopStart = zone.loopStartSeconds;
      source.loopEnd = zone.loopEndSeconds;
      source.playbackRate.setValueAtTime(2 ** ((note - zone.rootNote) / 12), now);
      source.connect(gain);
      gain.connect(this.master);
      gain.gain.setValueAtTime(attackSeconds === 0 ? peak : 0, now);
      if (attackSeconds > 0) gain.gain.linearRampToValueAtTime(peak, now + attackSeconds);
      if (decaySeconds > 0) gain.gain.linearRampToValueAtTime(sustain, now + attackSeconds + decaySeconds);
      else gain.gain.setValueAtTime(sustain, now + attackSeconds);
      const voice = { note, voiceId, zone, source, gain, peak, sustain, startTime: now, attackSeconds, decaySeconds, releasing: false };
      this.voices.add(voice);
      source.onended = () => this._cleanVoice(voice);
      try {
        if (source.loop) source.start(now, zone.startSeconds);
        else source.start(now, zone.startSeconds, zone.endSeconds - zone.startSeconds);
      } catch (error) { this._cleanVoice(voice); throw error; }
    }
  }

  noteOff(note, voiceId = undefined) {
    this._ensureLive();
    if (!Number.isInteger(note) || note < 0 || note > 127) throw new RangeError('Invalid MIDI note');
    if (voiceId !== undefined && (typeof voiceId !== 'string' || !voiceId)) throw new TypeError('Voice id must be a nonempty string');
    for (const voice of this.voices) if (voice.note === note && (voiceId === undefined || voice.voiceId === voiceId) && !voice.releasing) this._release(voice);
  }

  allNotesOff() {
    this._ensureLive();
    for (const voice of this.voices) if (!voice.releasing) this._release(voice);
  }

  _release(voice) {
    const now = this.context.currentTime;
    const release = this.parameters.releaseMs / 1000;
    const elapsed = Math.max(0, now - voice.startTime);
    let current;
    if (voice.attackSeconds > 0 && elapsed < voice.attackSeconds) {
      current = voice.peak * elapsed / voice.attackSeconds;
    } else if (voice.decaySeconds > 0 && elapsed < voice.attackSeconds + voice.decaySeconds) {
      current = voice.peak + (voice.sustain - voice.peak) * (elapsed - voice.attackSeconds) / voice.decaySeconds;
    } else {
      current = voice.sustain;
    }
    voice.releasing = true;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(current, now);
    if (release > 0) voice.gain.gain.linearRampToValueAtTime(0, now + release);
    else voice.gain.gain.setValueAtTime(0, now);
    try { voice.source.stop(now + release); } catch { this._cleanVoice(voice); }
  }

  _cleanVoice(voice) {
    if (!this.voices.delete(voice)) return;
    voice.source.onended = null;
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  _endNow(voice) {
    if (!voice) return;
    try { voice.source.stop(this.context.currentTime); } catch { /* node may already have ended */ }
    this._cleanVoice(voice);
  }

  _stopImmediately() { for (const voice of [...this.voices]) this._endNow(voice); }
  _ensureLive() { if (this._disposed) throw new Error('Sampler has been disposed'); }
  _superseded() { const error = new Error('Sample load was superseded'); error.name = 'AbortError'; return error; }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._loadGeneration++;
    this._stopImmediately();
    this.buffer = null;
    this.zones = [];
    this.master.disconnect();
    this.filter.disconnect();
  }
}
