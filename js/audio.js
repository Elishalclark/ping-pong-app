// Microphone front end: opens the mic with every browser "helpfulness" feature
// switched off (AGC and noise suppression both eat ball clicks), runs the
// onset worklet, and classifies each transient it reports.

export const CONTACT = {
  TABLE: 'table',   // ball on the playing surface
  PADDLE: 'paddle', // ball on a racket
  NET: 'net',
  OTHER: 'other',
};

export class AudioReferee {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.onOnset = () => {};
    this.onLevel = () => {};
    this.timeOffset = 0;   // performance.now() ms at audio currentTime 0
    this.settings = { sensitivity: 4.5, gateDb: -48 };
    this.running = false;
    this.mode = null;   // 'worklet' | 'fallback'
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // All three of these are designed to remove short, sharp, repetitive
        // sounds — which is exactly what a ball hitting a table is. They stay
        // off even though phones enable them by default.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    // iOS starts every context suspended until a gesture unlocks it; start()
    // is only ever called from a tap, so this is where it comes alive.
    await this.ctx.resume();
    this.timeOffset = performance.now() - this.ctx.currentTime * 1000;

    const src = this.ctx.createMediaStreamSource(this.stream);
    const mute = this.ctx.createGain();
    mute.gain.value = 0;   // keeps the graph pulling without making a sound

    try {
      const url = new URL('./onset-processor.js', import.meta.url);
      await this.ctx.audioWorklet.addModule(url);
      this.node = new AudioWorkletNode(this.ctx, 'onset-processor', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      });
      this.node.port.onmessage = e => this._handle(e.data);
      this.mode = 'worklet';
    } catch {
      // Older iOS Safari has no AudioWorklet. ScriptProcessor is deprecated
      // and runs on the main thread, so timing is looser, but a working
      // referee with softer timing beats no referee at all.
      await this._startFallback();
    }

    src.connect(this.node);
    this.node.connect(mute).connect(this.ctx.destination);

    this.applySettings(this.settings);
    this.running = true;
    return this.mode;
  }

  async _startFallback() {
    const { TransientDetector } = await import('./detector.js');
    const det = new TransientDetector({ sampleRate: this.ctx.sampleRate });
    const node = this.ctx.createScriptProcessor(512, 1, 1);
    node.onaudioprocess = e => {
      const ch = e.inputBuffer.getChannelData(0);
      const { level, onset } = det.process(ch, this.ctx.currentTime, this.settings);
      this._handle({ type: 'level', ...level });
      if (onset) this._handle({ type: 'onset', ...onset });
    };
    this.node = node;
    this.mode = 'fallback';
  }

  /** Phones suspend audio in the background; call this on the way back. */
  async resume() {
    if (this.ctx?.state === 'suspended') {
      await this.ctx.resume();
      this.timeOffset = performance.now() - this.ctx.currentTime * 1000;
    }
  }

  applySettings(s) {
    Object.assign(this.settings, s);
    if (this.mode !== 'worklet' || !this.node) return;  // fallback reads them directly
    const p = this.node.parameters;
    p.get('sensitivity').value = this.settings.sensitivity;
    p.get('gateDb').value = this.settings.gateDb;
  }

  stop() {
    this.running = false;
    if (this.node) this.node.onaudioprocess = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.node?.disconnect();
    this.ctx?.close();
    this.ctx = this.node = this.stream = null;
  }

  _handle(msg) {
    if (msg.type === 'level') {
      this.onLevel(msg);
      return;
    }
    const cls = classify(msg);
    this.onOnset({
      ...msg,
      ...cls,
      // Put the event on the same clock the video tracker uses.
      wallTime: this.timeOffset + msg.t * 1000,
    });
  }
}

/**
 * A 40 mm celluloid ball on a table gives a short, bright click: dominant
 * energy up around 2-6 kHz, gone inside ~15 ms. A racket's rubber and wood
 * ring lower and longer; a net touch is quiet and dull. These bands are wide
 * on purpose — room and mic colour the sound a lot, and the video tracker gets
 * the final say on where the ball actually was.
 */
export function classify(o) {
  const { zcr, decayMs, db } = o;
  let contact = CONTACT.OTHER;
  let confidence = 0.3;

  if (zcr > 1800 && decayMs < 22) {
    contact = CONTACT.TABLE;
    confidence = clamp(0.55 + (zcr - 1800) / 6000 + (18 - decayMs) / 60, 0.4, 0.95);
  } else if (zcr > 700 && decayMs < 45) {
    contact = CONTACT.PADDLE;
    confidence = clamp(0.5 + (35 - decayMs) / 80, 0.35, 0.85);
  } else if (db < -34 && zcr < 900) {
    contact = CONTACT.NET;
    confidence = 0.4;
  }

  // Very quiet transients are more likely to be room noise than contact.
  if (db < -42) confidence *= 0.6;
  return { contact, confidence: round2(confidence) };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round2 = v => Math.round(v * 100) / 100;
