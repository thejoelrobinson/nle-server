/**
 * webcodecs_decoder.js – Hardware-accelerated video decoder using WebCodecs API.
 *
 * Falls back gracefully to null if WebCodecs is unavailable or codec unsupported.
 * The caller is responsible for calling frame.close() on every VideoFrame returned
 * by decodeChunk() once it has been consumed (e.g. converted to ImageBitmap).
 */
export class WebCodecsDecoder {
    constructor() {
        this._decoder      = null;
        this._resolveFrame = null;
        this._config       = null;
        this._ready        = false;
    }

    static isSupported() {
        return typeof VideoDecoder !== 'undefined';
    }

    static async isCodecSupported(codec) {
        if (!WebCodecsDecoder.isSupported()) return false;
        try {
            const result = await VideoDecoder.isConfigSupported({
                codec,
                hardwareAcceleration: 'prefer-hardware',
            });
            return result.supported;
        } catch { return false; }
    }

    /**
     * Map FFmpeg AVCodecID integer to a WebCodecs codec string.
     * Returns null for unrecognised codecs — caller should fall back to WASM.
     *
     * Common FFmpeg codec IDs:
     *   H.264     = 27
     *   HEVC      = 173
     *   VP9       = 167
     *   AV1       = 225
     *   MJPEG     = 7
     */
    static codecStringFromId(codecId) {
        const map = {
            27:  'avc1.640028',          // H.264 High Profile Level 4.0
            173: 'hvc1.1.6.L120.90',    // HEVC Main Profile
            167: 'vp09.00.10.08',
            225: 'av01.0.04M.08',
            7:   'mjpg',                 // Motion JPEG
        };
        return map[codecId] ?? null;
    }

    /**
     * Initialise the underlying VideoDecoder with the given config.
     * @param {{ codec: string, codedWidth: number, codedHeight: number, description?: Uint8Array }} config
     */
    async init(config) {
        this._config = config;
        this._decoder = new VideoDecoder({
            output: (frame) => {
                if (this._resolveFrame) {
                    const resolve = this._resolveFrame;
                    this._resolveFrame = null;
                    resolve(frame);
                } else {
                    // Nobody waiting — free GPU memory immediately.
                    frame.close();
                }
            },
            error: (e) => {
                console.warn('[WebCodecs] decoder error:', e); // eslint-disable-line no-console
                if (this._resolveFrame) {
                    this._resolveFrame(null);
                    this._resolveFrame = null;
                }
            },
        });

        await this._decoder.configure({
            codec:                config.codec,
            codedWidth:           config.codedWidth,
            codedHeight:          config.codedHeight,
            hardwareAcceleration: 'prefer-hardware',
            optimizeForLatency:   true,
            ...(config.description ? { description: config.description } : {}),
        });

        this._ready = true;
    }

    get ready() { return this._ready; }

    /**
     * Decode a single encoded chunk and return the resulting VideoFrame.
     * The caller MUST call frame.close() after use to free GPU memory.
     *
     * @param {{ data: Uint8Array, timestamp: number, type: 'key'|'delta' }} encodedChunk
     * @returns {Promise<VideoFrame|null>}
     */
    async decodeChunk(encodedChunk) {
        if (!this._ready) return null;

        const chunk = new EncodedVideoChunk({
            type:      encodedChunk.type,
            timestamp: encodedChunk.timestamp,
            data:      encodedChunk.data,
        });

        const framePromise = new Promise((resolve) => {
            this._resolveFrame = resolve;
        });

        this._decoder.decode(chunk);
        await this._decoder.flush();

        // flush() guarantees all decoded frames have been output, so
        // _resolveFrame should already be called. If not (decoder silently
        // dropped the frame), resolve null to prevent an eternal hang.
        if (this._resolveFrame) {
            this._resolveFrame(null);
            this._resolveFrame = null;
        }

        return framePromise;
    }

    destroy() {
        if (this._decoder && this._decoder.state !== 'closed') {
            this._decoder.close();
        }
        this._ready  = false;
        this._decoder = null;
    }
}
