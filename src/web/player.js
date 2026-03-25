/**
 * player.js – WebGL1 YUV frame renderer
 *
 * Accepts raw YUV420P planes from the WASM decoder and converts them to RGB
 * entirely on the GPU via a BT.601 fragment shader.  Three LUMINANCE textures
 * (Y, U, V) replace the single RGBA texture, eliminating the sws_scale CPU
 * conversion step.
 */

const VERT_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_scale;
uniform vec2 u_offset;
varying   vec2 vTexCoord;
void main() {
  vTexCoord   = a_uv;
  gl_Position = vec4(a_pos * u_scale + u_offset, 0.0, 1.0);
}
`;

// Pass-through fragment shader for pre-decoded RGBA frames (WebCodecs / ImageBitmap path).
// The GPU already performed YUV→RGB during hardware decode; we just sample the texture.
const FRAG_SRC_RGBA = `
precision mediump float;
uniform sampler2D uTex;
uniform float     uOpacity;
varying   vec2 vTexCoord;
void main() {
  vec4 c = texture2D(uTex, vTexCoord);
  gl_FragColor = vec4(c.rgb, c.a * uOpacity);
}
`;

// Blend mode compositor shader — applies blend mode between FBO and background
const FRAG_SRC_BLEND = `
precision mediump float;
uniform sampler2D uFbo;        // Current layer FBO
uniform sampler2D uBackground; // Accumulated background
uniform int       uBlendMode;  // 0=normal, 1=multiply, 2=screen, 3=overlay, 4=add
varying   vec2 vTexCoord;

vec3 multiply(vec3 fg, vec3 bg) { return fg * bg; }
vec3 screen(vec3 fg, vec3 bg) { return 1.0 - (1.0 - fg) * (1.0 - bg); }
vec3 overlay(vec3 fg, vec3 bg) {
  return mix(2.0 * fg * bg, 1.0 - 2.0 * (1.0 - fg) * (1.0 - bg), step(0.5, bg));
}
vec3 add(vec3 fg, vec3 bg) { return clamp(fg + bg, 0.0, 1.0); }

void main() {
  vec4 fgColor = texture2D(uFbo, vTexCoord);
  vec4 bgColor = texture2D(uBackground, vTexCoord);

  vec3 blended = bgColor.rgb;
  if (uBlendMode == 1) blended = multiply(fgColor.rgb, bgColor.rgb);
  else if (uBlendMode == 2) blended = screen(fgColor.rgb, bgColor.rgb);
  else if (uBlendMode == 3) blended = overlay(fgColor.rgb, bgColor.rgb);
  else if (uBlendMode == 4) blended = add(fgColor.rgb, bgColor.rgb);
  else blended = mix(bgColor.rgb, fgColor.rgb, fgColor.a);

  gl_FragColor = vec4(blended, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTexY;
uniform sampler2D uTexU;
uniform sampler2D uTexV;
uniform int uColorspace;
uniform float     uOpacity;
varying vec2 vTexCoord;

void main() {
    float y = texture2D(uTexY, vTexCoord).r - 0.0625;
    float u = texture2D(uTexU, vTexCoord).r - 0.5;
    float v = texture2D(uTexV, vTexCoord).r - 0.5;

    float r, g, b;
    if (uColorspace == 1) {
        // BT.709 (HD)
        r = 1.164 * y + 1.793 * v;
        g = 1.164 * y - 0.213 * u - 0.533 * v;
        b = 1.164 * y + 2.112 * u;
    } else if (uColorspace == 2) {
        // BT.2020 (UHD/HDR)
        r = 1.164 * y + 1.678 * v;
        g = 1.164 * y - 0.188 * u - 0.652 * v;
        b = 1.164 * y + 2.163 * u;
    } else {
        // BT.601 (SD/default)
        r = 1.164 * y + 1.596 * v;
        g = 1.164 * y - 0.392 * u - 0.813 * v;
        b = 1.164 * y + 2.017 * u;
    }

    gl_FragColor = vec4(clamp(r, 0.0, 1.0), clamp(g, 0.0, 1.0), clamp(b, 0.0, 1.0), uOpacity);
}
`;

function compileShader(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error('Shader compile error: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function createProgram(gl, vertSrc, fragSrc) {
  const prog = gl.createProgram();
  gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER,   vertSrc));
  gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
  return prog;
}

export class Player {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.width  = 0;
    this.height = 0;

    const gl = canvas.getContext('webgl', {
      antialias: false,
      alpha:     true,
      depth:     false,
      stencil:   false,
    });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    // Track whether textures have been allocated so we can use texSubImage2D
    // (no GPU realloc) for subsequent same-size uploads.  Saves ~3 × 8 MB of
    // driver-side reallocation every frame for 4K sources.
    this._textureInitialized     = false;
    this._rgbaTextureInitialized = false;
    this._lastYuvWidth = 0;      // Track last YUV dimensions for safety checks
    this._lastYuvHeight = 0;

    // Sequence mode: when true, canvas is locked to sequence resolution
    this._seqMode = false;
    this._seqW    = 0;
    this._seqH    = 0;

    // FBO infrastructure for blend modes (initialized on demand)
    this._fboPool = [];           // Pool of FBOs for layer rendering
    this._currentFboCount = 0;

    this._initGL();
  }

  _createFBO(width, height) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

    const tex = this._createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, tex };
  }

  _ensureFBOsForSize(width, height) {
    // Pre-allocate FBOs for the sequence size (up to 4 layers)
    while (this._fboPool.length < 4) {
      this._fboPool.push(this._createFBO(width, height));
    }
  }

  _needsFBO(blendMode) {
    // Blend modes 1-4 need FBO rendering (multiply, screen, overlay, add)
    return blendMode > 0 && blendMode <= 4;
  }

  _createTexture() {
    const gl  = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    return tex;
  }

  _initGL() {
    const gl = this.gl;

    // ── Fullscreen quad (clip-space coords + UV) ─────────────────────────
    //   Two triangles covering NDC [-1,1]x[-1,1].
    //   UV origin is top-left (v flipped so Y matches canvas convention).
    const verts = new Float32Array([
      // x     y     u    v
      -1.0,  1.0,  0.0, 0.0,
      -1.0, -1.0,  0.0, 1.0,
       1.0,  1.0,  1.0, 0.0,
       1.0, -1.0,  1.0, 1.0,
    ]);

    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

    // ── Shader program ───────────────────────────────────────────────────
    this.prog           = createProgram(gl, VERT_SRC, FRAG_SRC);
    this.loc_pos        = gl.getAttribLocation(this.prog, 'a_pos');
    this.loc_uv         = gl.getAttribLocation(this.prog, 'a_uv');
    this.loc_scale      = gl.getUniformLocation(this.prog, 'u_scale');
    this.loc_offset     = gl.getUniformLocation(this.prog, 'u_offset');
    this.loc_texY       = gl.getUniformLocation(this.prog, 'uTexY');
    this.loc_texU       = gl.getUniformLocation(this.prog, 'uTexU');
    this.loc_texV       = gl.getUniformLocation(this.prog, 'uTexV');
    this._uColorspace   = gl.getUniformLocation(this.prog, 'uColorspace');
    this._uOpacity      = gl.getUniformLocation(this.prog, 'uOpacity');

    // ── Three LUMINANCE textures for Y, U, V planes ──────────────────────
    this.textureY = this._createTexture();
    this.textureU = this._createTexture();
    this.textureV = this._createTexture();

    // ── RGBA pass-through program (WebCodecs / ImageBitmap path) ─────────
    this.progRgba      = createProgram(gl, VERT_SRC, FRAG_SRC_RGBA);
    this.locRgba_pos   = gl.getAttribLocation (this.progRgba, 'a_pos');
    this.locRgba_uv    = gl.getAttribLocation (this.progRgba, 'a_uv');
    this.locRgba_scale = gl.getUniformLocation(this.progRgba, 'u_scale');
    this.locRgba_offset= gl.getUniformLocation(this.progRgba, 'u_offset');
    this.locRgba_tex   = gl.getUniformLocation(this.progRgba, 'uTex');
    this._uOpacityRgba = gl.getUniformLocation(this.progRgba, 'uOpacity');
    this.textureRgba   = this._createTexture();

    // ── Blend mode compositor program ────────────────────────────────────────
    this.progBlend     = createProgram(gl, VERT_SRC, FRAG_SRC_BLEND);
    this.locBlend_pos  = gl.getAttribLocation (this.progBlend, 'a_pos');
    this.locBlend_uv   = gl.getAttribLocation (this.progBlend, 'a_uv');
    this.locBlend_fbo  = gl.getUniformLocation(this.progBlend, 'uFbo');
    this.locBlend_bg   = gl.getUniformLocation(this.progBlend, 'uBackground');
    this.locBlend_mode = gl.getUniformLocation(this.progBlend, 'uBlendMode');

    // Without UNPACK_ALIGNMENT=1, WebGL pads each row to a 4-byte boundary.
    // For odd-width chroma planes (e.g. 1920-wide U/V at 4K) that causes
    // corrupted textures.  Setting 1 means no implicit padding.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // Enable WebGL blending for compositing multiple layers
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(
      gl.SRC_ALPHA,           gl.ONE_MINUS_SRC_ALPHA,  // RGB: over compositing
      gl.ONE,                  gl.ONE_MINUS_SRC_ALPHA   // Alpha: accumulate correctly
    );

    gl.clearColor(0, 0, 0, 1);
  }

  /**
   * Upload a single luminance plane and handle stride padding.
   * WebGL1 has no UNPACK_ROW_LENGTH, so rows with padding must be stripped.
   *
   * On the first upload (isUpdate=false) texImage2D allocates GPU memory.
   * On subsequent uploads of the same dimensions (isUpdate=true) texSubImage2D
   * reuses the allocation, avoiding a GPU realloc + driver sync on every frame.
   * For 4K this saves ~3 × 8 MB of reallocation per frame.
   *
   * @param {WebGLTexture} texture
   * @param {Uint8Array}   data     – raw plane bytes (may include row padding)
   * @param {number}       width    – logical pixel width of this plane
   * @param {number}       height   – logical pixel height of this plane
   * @param {number}       stride   – bytes per row (>= width when padded)
   * @param {boolean}      isUpdate – true → texSubImage2D, false → texImage2D
   */
  _uploadPlane(texture, data, width, height, stride, isUpdate) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);

    let pixels;
    if (stride === width) {
      pixels = data;
    } else {
      // Strip row padding into a tightly packed buffer
      pixels = new Uint8Array(width * height);
      for (let row = 0; row < height; row++) {
        pixels.set(
          data.subarray(row * stride, row * stride + width),
          row * width
        );
      }
    }

    if (isUpdate) {
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, 0,
        width, height,
        gl.LUMINANCE, gl.UNSIGNED_BYTE,
        pixels
      );
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.LUMINANCE,
        width, height, 0,
        gl.LUMINANCE, gl.UNSIGNED_BYTE,
        pixels
      );
    }
  }

  /**
   * Set the canvas to sequence mode: lock to fixed sequence dimensions.
   * Called once from Playback when the player is initialized.
   * @param {number} seqW — sequence width
   * @param {number} seqH — sequence height
   */
  setSequenceMode(seqW, seqH) {
    this._seqMode = true;
    this._seqW = seqW;
    this._seqH = seqH;
    this.canvas.width = seqW;
    this.canvas.height = seqH;
    this.width = seqW;
    this.height = seqH;
    this.gl.viewport(0, 0, seqW, seqH);
    this._textureInitialized = false;
    this._rgbaTextureInitialized = false;
    this._lastYuvWidth = 0;  // Reset dimension tracking
    this._lastYuvHeight = 0;
  }

  /**
   * Draw a full-screen frame (legacy auto-resize path for source monitor).
   * Accepts either:
   *   - YUV path: { y, u, v, width, height, strideY, strideU, strideV, colorspace }
   *   - Bitmap path: { bitmap, width, height } — ImageBitmap from WebCodecs hardware decode
   * @param {object} frameData
   */
  drawFrameFull(frameData) {
    if (frameData?.bitmap) {
      this._drawBitmap(frameData.bitmap, frameData.width, frameData.height);
      return;
    }
    this._drawYUV(frameData);
  }

  /**
   * Alias for drawFrameFull (for backward compatibility with existing code/tests).
   * @deprecated Use drawFrameFull or drawFrameAt instead.
   */
  drawFrame(frameData) {
    return this.drawFrameFull(frameData);
  }

  /**
   * Draw a frame with a transform (compositing path for program monitor).
   * Does not resize canvas or call clear(). Caller is responsible for calling
   * clear() before the first drawFrameAt, and for setting uniforms correctly.
   * @param {object} frameData — { y, u, v, width, height, ... } or { bitmap, width, height, ... }
   * @param {object} transform — { scaleX, scaleY, offsetX, offsetY, opacity }
   */
  drawFrameAt(frameData, { scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0, opacity = 1.0 } = {}) {
    // Upload textures (mirrors _drawYUV/_drawBitmap setup)
    if (frameData?.bitmap) {
      this._uploadBitmap(frameData.bitmap, frameData.width, frameData.height);
      // Use RGBA program
      const gl = this.gl;
      gl.useProgram(this.progRgba);
      gl.uniform2f(this.locRgba_scale, scaleX, scaleY);
      gl.uniform2f(this.locRgba_offset, offsetX, offsetY);
      gl.uniform1f(this._uOpacityRgba, opacity);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 4 * 4;
      gl.enableVertexAttribArray(this.locRgba_pos);
      gl.vertexAttribPointer(this.locRgba_pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.locRgba_uv);
      gl.vertexAttribPointer(this.locRgba_uv, 2, gl.FLOAT, false, stride, 8);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textureRgba);
      gl.uniform1i(this.locRgba_tex, 0);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    } else {
      this._uploadYUV(frameData);
      // Use YUV program
      const gl = this.gl;
      gl.useProgram(this.prog);
      gl.uniform1i(this._uColorspace, frameData.colorspace ?? 0);
      gl.uniform2f(this.loc_scale, scaleX, scaleY);
      gl.uniform2f(this.loc_offset, offsetX, offsetY);
      gl.uniform1f(this._uOpacity, opacity);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
      const stride = 4 * 4;
      gl.enableVertexAttribArray(this.loc_pos);
      gl.vertexAttribPointer(this.loc_pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.loc_uv);
      gl.vertexAttribPointer(this.loc_uv, 2, gl.FLOAT, false, stride, 8);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.textureY);
      gl.uniform1i(this.loc_texY, 0);

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textureU);
      gl.uniform1i(this.loc_texU, 1);

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, this.textureV);
      gl.uniform1i(this.loc_texV, 2);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  /**
   * Upload RGBA bitmap texture only (no draw, no clear).
   * For use by both drawFrameFull and drawFrameAt paths.
   * @param {ImageBitmap} bitmap
   * @param {number} width
   * @param {number} height
   */
  _uploadBitmap(bitmap, width, height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.textureRgba);
    if (this._rgbaTextureInitialized) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      this._rgbaTextureInitialized = true;
    }
  }

  /**
   * Draw a pre-decoded RGBA ImageBitmap via the pass-through WebGL program.
   * Uses texSubImage2D for same-size frames (no GPU realloc).
   * This is the legacy auto-resize path for the source monitor.
   * @param {ImageBitmap} bitmap
   * @param {number} width
   * @param {number} height
   */
  _drawBitmap(bitmap, width, height) {
    const gl = this.gl;

    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
      this.width  = width;
      this.height = height;
      this._rgbaTextureInitialized = false;
      this._textureInitialized     = false;   // YUV textures now wrong size too
    }

    this._uploadBitmap(bitmap, width, height);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progRgba);
    gl.uniform1f(this._uOpacityRgba, 1.0);
    // Default scale (1,1) and offset (0,0) for fullscreen
    gl.uniform2f(this.locRgba_scale, 1.0, 1.0);
    gl.uniform2f(this.locRgba_offset, 0.0, 0.0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 4 * 4;
    gl.enableVertexAttribArray(this.locRgba_pos);
    gl.vertexAttribPointer(this.locRgba_pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.locRgba_uv);
    gl.vertexAttribPointer(this.locRgba_uv,  2, gl.FLOAT, false, stride, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureRgba);
    gl.uniform1i(this.locRgba_tex, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * Upload YUV planes only (no draw, no clear).
   * For use by both drawFrameFull and drawFrameAt paths.
   * @param {{ y, u, v, width, height, strideY, strideU, strideV }} frame
   */
  _uploadYUV({ y, u, v, width, height, strideY, strideU, strideV }) {
    // Safety check: if frame dimensions changed, force reallocation
    let isUpdate = this._textureInitialized;
    if (width !== this._lastYuvWidth || height !== this._lastYuvHeight) {
      isUpdate = false;  // Force texImage2D reallocation
      this._lastYuvWidth = width;
      this._lastYuvHeight = height;
    }

    this._uploadPlane(this.textureY, y, width,    height,    strideY, isUpdate);
    this._uploadPlane(this.textureU, u, width>>1, height>>1, strideU, isUpdate);
    this._uploadPlane(this.textureV, v, width>>1, height>>1, strideV, isUpdate);
    this._textureInitialized = true;
  }

  /**
   * Draw a YUV420P frame (legacy auto-resize path for source monitor).
   * @param {{ y, u, v, width, height, strideY, strideU, strideV, colorspace }} frame
   */
  _drawYUV({ y, u, v, width, height, strideY, strideU, strideV, colorspace = 0 }) {
    const gl = this.gl;

    // Resize canvas backing store if dimensions changed.
    // Also reset _textureInitialized so the next upload uses texImage2D to
    // reallocate GPU texture storage at the new size.
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
      this.width  = width;
      this.height = height;
      this._textureInitialized     = false;
      this._rgbaTextureInitialized = false;   // RGBA texture now wrong size too
    }

    // Upload the three planes.  Use texSubImage2D (no GPU realloc) for
    // same-size frames after the first upload.
    this._uploadYUV({ y, u, v, width, height, strideY, strideU, strideV });

    // Draw
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.uniform1i(this._uColorspace, colorspace);
    gl.uniform1f(this._uOpacity, 1.0);
    // Default scale (1,1) and offset (0,0) for fullscreen
    gl.uniform2f(this.loc_scale, 1.0, 1.0);
    gl.uniform2f(this.loc_offset, 0.0, 0.0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = 4 * 4; // 4 floats per vertex
    gl.enableVertexAttribArray(this.loc_pos);
    gl.vertexAttribPointer(this.loc_pos, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.loc_uv);
    gl.vertexAttribPointer(this.loc_uv,  2, gl.FLOAT, false, stride, 8);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textureY);
    gl.uniform1i(this.loc_texY, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.textureU);
    gl.uniform1i(this.loc_texU, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.textureV);
    gl.uniform1i(this.loc_texV, 2);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear() {
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  /**
   * Return the underlying WebGLRenderingContext.
   * Used by Playback to call gl.finish() before createImageBitmap() so that
   * all pending GPU commands complete before pixel capture.
   * @returns {WebGLRenderingContext}
   */
  getGLContext() { return this.gl; }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.textureY);
    gl.deleteTexture(this.textureU);
    gl.deleteTexture(this.textureV);
    gl.deleteTexture(this.textureRgba);
    gl.deleteBuffer(this.vbo);
    gl.deleteProgram(this.prog);
    gl.deleteProgram(this.progRgba);
  }
}
