import { Player } from './player.js';

function mapFFmpegColorspace(avcol_spc) {
    if (avcol_spc === 1) return 1;   // BT.709
    if (avcol_spc === 9) return 2;   // BT.2020
    return 0;                         // BT.601 default
}

export class Exporter {
    constructor(engine, pool) {
        this._engine = engine;
        this._pool = pool;
        this._cancelled = false;
    }

    cancel() { this._cancelled = true; }

    async export(sequenceId, onProgress) {
        this._cancelled = false;

        // Get sequence metadata
        const seqJson = JSON.parse(this._engine.get_sequence_json(sequenceId));
        const fps = seqJson.fps_num / seqJson.fps_den;
        const width = seqJson.width;
        const height = seqJson.height;

        // Figure out total duration: walk all clips and find the max timeline_out_pts
        let durationPts = 0;
        for (const track of [...(seqJson.video_tracks ?? []), ...(seqJson.audio_tracks ?? [])]) {
            for (const clip of (track.clips ?? [])) {
                if (clip.timeline_out_pts > durationPts) durationPts = clip.timeline_out_pts;
            }
        }
        if (durationPts <= 0) throw new Error('Sequence is empty');

        const totalFrames = Math.ceil((durationPts / 1_000_000) * fps);
        const frameDuration = 1_000_000 / fps;

        // Offscreen canvas + player
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const player = new Player(canvas);

        // MediaRecorder setup
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm';
        const stream = canvas.captureStream(fps);
        const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: 20_000_000
        });
        const chunks = [];
        recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

        recorder.start(1000); // collect data every 1s

        for (let f = 0; f < totalFrames; f++) {
            if (this._cancelled) {
                recorder.stop();
                return null;
            }

            const pts = f * frameDuration;
            const resolved = this._engine.resolve_frame(sequenceId, pts);

            if (resolved?.source_path) {
                const info = this._pool.getInfo(resolved.source_path);
                const colorspace = mapFFmpegColorspace(info?.colorspace ?? 5);
                const frame = await this._pool.decodeFrameAt(
                    resolved.source_path,
                    resolved.source_pts / 1e6
                );
                if (frame) player.drawFrame({ ...frame, colorspace });
            } else {
                // Gap — clear to black
                const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
                if (gl) { gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT); }
            }

            onProgress?.(f + 1, totalFrames);

            // Yield to browser every frame so UI stays responsive
            await new Promise(r => setTimeout(r, 0));
        }

        recorder.stop();
        await new Promise(r => recorder.onstop = r);

        const blob = new Blob(chunks, { type: 'video/webm' });
        return blob;
    }
}
