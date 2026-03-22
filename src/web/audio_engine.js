/**
 * audio_engine.js — Web Audio sink for timeline playback.
 *
 * Receives interleaved stereo Float32 samples decoded by FrameServer
 * and feeds them to the Web Audio API via a ScriptProcessorNode.
 *
 * Usage:
 *   const audio = new AudioEngine();
 *   await audio.init();          // must be called inside a user-gesture handler
 *   audio.start();
 *   audio.pushSamples(float32);  // push decoded chunks as they arrive
 *   audio.stop();
 */
export class AudioEngine {
  constructor() {
    this._ctx        = null;
    this._gainNode   = null;
    this._scriptNode = null;
    this._buffer     = new Float32Array(0);
    this._bufferPos  = 0;
    this._active     = false;
  }

  async init() {
    this._ctx      = new AudioContext({ sampleRate: 48000 });
    this._gainNode = this._ctx.createGain();
    this._gainNode.connect(this._ctx.destination);
    // ScriptProcessorNode is deprecated but still the only zero-latency option
    // in all browsers without a SharedArrayBuffer-based AudioWorklet.
    this._scriptNode = this._ctx.createScriptProcessor(4096, 0, 2);
    this._scriptNode.onaudioprocess = (e) => this._onProcess(e);
    this._scriptNode.connect(this._gainNode);
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

  /** Pause output and clear the pending buffer. */
  stop() {
    this._active    = false;
    this._buffer    = new Float32Array(0);
    this._bufferPos = 0;
  }

  /**
   * Append decoded interleaved stereo samples to the playback buffer.
   * @param {Float32Array} float32Array — interleaved L0, R0, L1, R1, …
   */
  pushSamples(float32Array) {
    const remaining = this._buffer.length - this._bufferPos;
    const newBuf    = new Float32Array(remaining + float32Array.length);
    newBuf.set(this._buffer.subarray(this._bufferPos));
    newBuf.set(float32Array, remaining);
    this._buffer    = newBuf;
    this._bufferPos = 0;
  }

  /** @param {number} v — gain value 0–1 */
  setVolume(v) {
    if (this._gainNode) this._gainNode.gain.value = v;
  }

  destroy() {
    this._scriptNode?.disconnect();
    this._gainNode?.disconnect();
    this._ctx?.close();
    this._ctx        = null;
    this._gainNode   = null;
    this._scriptNode = null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _onProcess(e) {
    const left   = e.outputBuffer.getChannelData(0);
    const right  = e.outputBuffer.getChannelData(1);
    const needed = left.length;
    const avail  = (this._buffer.length - this._bufferPos) / 2;

    if (!this._active || avail < needed) {
      left.fill(0);
      right.fill(0);
      return;
    }

    for (let i = 0; i < needed; i++) {
      left[i]  = this._buffer[this._bufferPos + i * 2];
      right[i] = this._buffer[this._bufferPos + i * 2 + 1];
    }
    this._bufferPos += needed * 2;
  }
}
