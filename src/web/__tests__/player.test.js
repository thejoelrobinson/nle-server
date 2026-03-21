import { describe, it, expect } from 'vitest';
import { Player } from '../player.js';

// ── WebGL mock ────────────────────────────────────────────────────────────

/**
 * Creates a minimal WebGL1 context mock that returns sensible values for
 * every method the Player constructor and drawFrame() call.
 */
function createMockGl() {
  let idCounter = 1;
  const obj = () => ({ _id: idCounter++ });

  return {
    // Constants used by Player
    ARRAY_BUFFER:        0x8892,
    STATIC_DRAW:         0x88E4,
    VERTEX_SHADER:       0x8B31,
    FRAGMENT_SHADER:     0x8B30,
    COMPILE_STATUS:      0x8B81,
    LINK_STATUS:         0x8B82,
    TEXTURE_2D:          0x0DE1,
    TEXTURE_MIN_FILTER:  0x2801,
    TEXTURE_MAG_FILTER:  0x2800,
    TEXTURE_WRAP_S:      0x2802,
    TEXTURE_WRAP_T:      0x2803,
    LINEAR:              0x2601,
    CLAMP_TO_EDGE:       0x812F,
    LUMINANCE:           0x1909,
    UNSIGNED_BYTE:       0x1401,
    FLOAT:               0x1406,
    TRIANGLE_STRIP:      0x0005,
    TEXTURE0:            0x84C0,
    TEXTURE1:            0x84C1,
    TEXTURE2:            0x84C2,
    COLOR_BUFFER_BIT:    0x4000,

    // Buffer
    createBuffer:            obj,
    bindBuffer:              () => {},
    bufferData:              () => {},

    // Shaders
    createShader:            obj,
    shaderSource:            () => {},
    compileShader:           () => {},
    getShaderParameter:      () => true,
    getShaderInfoLog:        () => '',

    // Program
    createProgram:           obj,
    attachShader:            () => {},
    linkProgram:             () => {},
    getProgramParameter:     () => true,
    getProgramInfoLog:       () => '',
    getAttribLocation:       () => 0,
    getUniformLocation:      obj,
    useProgram:              () => {},

    // Texture
    createTexture:           obj,
    bindTexture:             () => {},
    texParameteri:           () => {},
    texImage2D:              () => {},
    activeTexture:           () => {},
    uniform1i:               () => {},

    // Draw
    clearColor:              () => {},
    clear:                   () => {},
    viewport:                () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer:     () => {},
    drawArrays:              () => {},

    // Cleanup
    deleteTexture:           () => {},
    deleteBuffer:            () => {},
    deleteProgram:           () => {},
  };
}

function makeCanvas(gl) {
  return {
    getContext: () => gl,
    width:  0,
    height: 0,
  };
}

/** Build a minimal packed YUV frame object for the given dimensions. */
function makeYuvFrame(width, height, { strideY, strideU, strideV } = {}) {
  const sY = strideY ?? width;
  const sU = strideU ?? (width >> 1);
  const sV = strideV ?? (width >> 1);
  return {
    y: new Uint8Array(sY * height),
    u: new Uint8Array(sU * (height >> 1)),
    v: new Uint8Array(sV * (height >> 1)),
    width,
    height,
    strideY: sY,
    strideU: sU,
    strideV: sV,
  };
}

// ── Player ────────────────────────────────────────────────────────────────

describe('Player', () => {

  describe('constructor', () => {
    it('throws a TypeError if canvas is null', () => {
      expect(() => new Player(null)).toThrow(TypeError);
    });

    it('throws if the canvas cannot provide a WebGL context', () => {
      const canvas = { getContext: () => null };
      expect(() => new Player(canvas)).toThrow('WebGL not supported');
    });

    it('initialises width and height to 0', () => {
      const player = new Player(makeCanvas(createMockGl()));
      expect(player.width).toBe(0);
      expect(player.height).toBe(0);
    });

    it('stores a reference to the canvas', () => {
      const canvas = makeCanvas(createMockGl());
      const player = new Player(canvas);
      expect(player.canvas).toBe(canvas);
    });

    it('creates non-null Y, U, V textures during initialisation', () => {
      const player = new Player(makeCanvas(createMockGl()));
      expect(player.textureY).not.toBeNull();
      expect(player.textureU).not.toBeNull();
      expect(player.textureV).not.toBeNull();
    });
  });

  describe('drawFrame()', () => {
    it('updates internal width and height on first frame', () => {
      const player = new Player(makeCanvas(createMockGl()));
      player.drawFrame(makeYuvFrame(320, 240));
      expect(player.width).toBe(320);
      expect(player.height).toBe(240);
    });

    it('updates dimensions when frame size changes', () => {
      const canvas = makeCanvas(createMockGl());
      const player = new Player(canvas);

      player.drawFrame(makeYuvFrame(320, 240));
      expect(player.width).toBe(320);

      player.drawFrame(makeYuvFrame(1920, 1080));
      expect(player.width).toBe(1920);
      expect(player.height).toBe(1080);
    });

    it('sets canvas backing-store dimensions to match the frame', () => {
      const canvas = makeCanvas(createMockGl());
      const player = new Player(canvas);

      player.drawFrame(makeYuvFrame(640, 360));

      expect(canvas.width).toBe(640);
      expect(canvas.height).toBe(360);
    });

    it('does not throw with a packed frame (stride == width)', () => {
      const player = new Player(makeCanvas(createMockGl()));
      expect(() => player.drawFrame(makeYuvFrame(100, 100))).not.toThrow();
    });

    it('does not throw when strideY > width (padded rows)', () => {
      const player = new Player(makeCanvas(createMockGl()));
      // stride padded to next 64-byte boundary
      const strideY = 128;   // > width 100
      const strideU = 64;    // > width/2 50
      const strideV = 64;
      expect(() =>
        player.drawFrame(makeYuvFrame(100, 100, { strideY, strideU, strideV }))
      ).not.toThrow();
    });
  });

  describe('destroy()', () => {
    it('does not throw', () => {
      const player = new Player(makeCanvas(createMockGl()));
      expect(() => player.destroy()).not.toThrow();
    });
  });

});
