/**
 * player.js – WebGL1 frame renderer
 *
 * Accepts raw RGBA Uint8Array frames and displays them on a <canvas> using a
 * simple fullscreen-quad shader.  WebGL1 is used for maximum browser compat.
 */

const VERT_SRC = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying   vec2 v_uv;
void main() {
  v_uv        = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const FRAG_SRC = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() {
  gl_FragColor = texture2D(u_tex, v_uv);
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

    const gl = canvas.getContext('webgl', {
      antialias: false,
      alpha:     false,
      depth:     false,
      stencil:   false,
    });
    if (!gl) throw new Error('WebGL not supported');
    this.gl = gl;

    this._initGL();
    this.width  = 0;
    this.height = 0;
    this.texture = null;
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
    this.prog    = createProgram(gl, VERT_SRC, FRAG_SRC);
    this.loc_pos = gl.getAttribLocation(this.prog, 'a_pos');
    this.loc_uv  = gl.getAttribLocation(this.prog, 'a_uv');
    this.loc_tex = gl.getUniformLocation(this.prog, 'u_tex');

    // ── Texture (allocated lazily on first frame) ────────────────────────
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);

    gl.clearColor(0, 0, 0, 1);
  }

  /**
   * Upload an RGBA frame and draw it.
   * @param {Uint8Array|Uint8ClampedArray} rgba  – width*height*4 bytes
   * @param {number} width
   * @param {number} height
   */
  drawFrame(rgba, width, height) {
    const gl = this.gl;

    // Resize canvas backing store if needed
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width  = width;
      this.canvas.height = height;
      gl.viewport(0, 0, width, height);
      this.width  = width;
      this.height = height;
    }

    // Upload texture
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      width, height, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength)
    );

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
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.loc_tex, 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  clear() {
    const gl = this.gl;
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.vbo);
    gl.deleteProgram(this.prog);
  }
}
