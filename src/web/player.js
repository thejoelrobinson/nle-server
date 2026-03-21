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
varying   vec2 vTexCoord;
void main() {
  vTexCoord   = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D uTextureY;
uniform sampler2D uTextureU;
uniform sampler2D uTextureV;
varying vec2 vTexCoord;
void main() {
  float y = texture2D(uTextureY, vTexCoord).r;
  float u = texture2D(uTextureU, vTexCoord).r - 0.5;
  float v = texture2D(uTextureV, vTexCoord).r - 0.5;
  float r = y + 1.402 * v;
  float g = y - 0.344 * u - 0.714 * v;
  float b = y + 1.772 * u;
  gl_FragColor = vec4(r, g, b, 1.0);
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
      alpha:     false,
      depth:     false,
      stencil:   false,
    });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    this._initGL();
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
    this.prog       = createProgram(gl, VERT_SRC, FRAG_SRC);
    this.loc_pos    = gl.getAttribLocation(this.prog, 'a_pos');
    this.loc_uv     = gl.getAttribLocation(this.prog, 'a_uv');
    this.loc_texY   = gl.getUniformLocation(this.prog, 'uTextureY');
    this.loc_texU   = gl.getUniformLocation(this.prog, 'uTextureU');
    this.loc_texV   = gl.getUniformLocation(this.prog, 'uTextureV');

    // ── Three LUMINANCE textures for Y, U, V planes ──────────────────────
    this.textureY = this._createTexture();
    this.textureU = this._createTexture();
    this.textureV = this._createTexture();

    gl.clearColor(0, 0, 0, 1);
  }

  /**
   * Upload a single luminance plane and handle stride padding.
   * WebGL1 has no UNPACK_ROW_LENGTH, so rows with padding must be stripped.
   *
   * @param {WebGLTexture} texture
   * @param {Uint8Array}   data    – raw plane bytes (may include row padding)
   * @param {number}       width   – logical pixel width of this plane
   * @param {number}       height  – logical pixel height of this plane
   * @param {number}       stride  – bytes per row (>= width when padded)
   */
  _uploadPlane(texture, data, width, height, stride) {
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

    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.LUMINANCE,
      width, height, 0,
      gl.LUMINANCE, gl.UNSIGNED_BYTE,
      pixels
    );
  }

  /**
   * Upload a YUV420P frame and draw it.
   * @param {{ y, u, v, width, height, strideY, strideU, strideV }} frame
   */
  drawFrame({ y, u, v, width, height, strideY, strideU, strideV }) {
    const gl = this.gl;

    // Resize canvas backing store if dimensions changed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
      this.width  = width;
      this.height = height;
    }

    // Upload the three planes
    this._uploadPlane(this.textureY, y, width,    height,    strideY);
    this._uploadPlane(this.textureU, u, width>>1, height>>1, strideU);
    this._uploadPlane(this.textureV, v, width>>1, height>>1, strideV);

    // Draw
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);

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

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.textureY);
    gl.deleteTexture(this.textureU);
    gl.deleteTexture(this.textureV);
    gl.deleteBuffer(this.vbo);
    gl.deleteProgram(this.prog);
  }
}
