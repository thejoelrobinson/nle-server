/**
 * audio_engine.js — Web Audio sink for timeline playback.
 *
 * Receives interleaved stereo Float32 samples decoded by FrameServer and feeds
 * them to the Web Audio API via an AudioWorkletNode running on the audio
 * rendering thread — replacing the deprecated ScriptProcessorNode that ran on
 * the main thread and triggered "[Deprecation] ScriptProcessorNode" warnings.
 *
 * The AudioWorklet processor is inlined as a blob URL so no extra static file
 * is required, keeping the module self-contained for both dev and prod builds.
 *
 * Usage:
 *   const audio = new AudioEngine();
 *   await audio.init();          // must be called inside a user-gesture handler
 *   audio.start();
 *   audio.pushSamples(float32);  // push decoded chunks as they arrive
 *   audio.stop();
 */

/**
 * AudioWorklet processor source — runs on the audio rendering thread.
 * Receives interleaved stereo Float32 chunks via port.onmessage and
 * deinterleaves them into L/R output channels every 128-sample quantum.
 */
const PROCESSOR_SRC = `
class NLEProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this._buffer = new Float32Array(0);
        this._pos    = 0;
        this.port.onmessage = (e) => {
            if (e.data.samples) this._pushSamples(e.data.samples);
        };
    }

    _pushSamples(incoming) {
        const remaining = this._buffer.length - this._pos;
        const next      = new Float32Array(remaining + incoming.length);
        next.set(this._buffer.subarray(this._pos));
        next.set(incoming, remaining);
        this._buffer = next;
        this._pos    = 0;
    }

    process(inputs, outputs) {
        const left  = outputs[0][0];
        const right = outputs[0][1];
        if (!left) return true;
        const needed    = left.length;
        const available = (this._buffer.length - this._pos) / 2;
        if (available < needed) {
            left.fill(0); right.fill(0);
            return true;
        }
        for (let i = 0; i < needed; i++) {
            left[i]  = this._buffer[this._pos + i * 2];
            right[i] = this._buffer[this._pos + i * 2 + 1];
        }
        this._pos += needed * 2;
        return true;
    }
}
registerProcessor('nle-processor', NLEProcessor);
`;

export class AudioEngine {
  constructor() {
    this._ctx         = null;
    this._workletNode = null;
    this._gainNode    = null;
    this._active      = false;
  }

  /**
   * Create AudioContext and load the AudioWorklet module.
   * Must be called from a user-gesture handler (click, keydown, etc.).
   */
  async init() {
    this._ctx = new AudioContext({ sampleRate: 48000 });

    // Inline the processor as a blob URL — no static file serving needed.
    const blob      = new Blob([PROCESSOR_SRC], { type: 'application/javascript' });
    const blobUrl   = URL.createObjectURL(blob);
    try {
      await this._ctx.audioWorklet.addModule(blobUrl);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    this._workletNode = new AudioWorkletNode(this._ctx, 'nle-processor', {
      numberOfInputs:     0,
      numberOfOutputs:    1,
      outputChannelCount: [2],
    });

    this._gainNode = this._ctx.createGain();
    this._workletNode.connect(this._gainNode);
    this._gainNode.connect(this._ctx.destination);
  }

  /** AudioContext currentTime, or 0 before init(). */
  get currentTime() { return this._ctx?.currentTime ?? 0; }

  /** True while the engine is running and consuming samples. */
  get isRunning() { return this._active; }

  /** Resume context + begin consuming samples (call inside user gesture). */
  start() {
    if (this._ctx?.state === 'suspended') this._ctx.resume();
    this._active = true;
  }

  /** Pause output. */
  stop() {
    this._active = false;
  }

  /**
   * Transfer decoded interleaved stereo samples to the worklet thread.
   * Uses a zero-copy ArrayBuffer transfer so neither thread holds a stale copy.
   * @param {Float32Array} float32Array — interleaved L0, R0, L1, R1, …
   */
  pushSamples(float32Array) {
    if (!this._workletNode) return;
    const copy = float32Array.slice();
    this._workletNode.port.postMessage({ samples: copy }, [copy.buffer]);
  }

  /** @param {number} v — gain value 0–1 */
  setVolume(v) {
    if (this._gainNode) this._gainNode.gain.value = v;
  }

  destroy() {
    this._workletNode?.disconnect();
    this._gainNode?.disconnect();
    this._ctx?.close();
    this._ctx         = null;
    this._workletNode = null;
    this._gainNode    = null;
  }
}
