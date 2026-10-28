// 程序化贴图：棋盘/噪声/法线/金属粗糙度，全部用代码生成，零外部资源依赖。

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 值噪声（双线性插值的哈希噪声）
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 1442695040888963407;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function smooth(t) { return t * t * (3 - 2 * t); }
function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - xf) + b * xf) * (1 - yf) + (c * (1 - xf) + d * xf) * yf;
}
function fbm(x, y, octaves, seed) {
  let sum = 0, amp = 0.5, freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq, seed + i * 17) * amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

export function checkerTexture(size = 256, cells = 8, c1 = [210, 210, 215], c2 = [150, 152, 160]) {
  const data = new Uint8Array(size * size * 4);
  const cell = size / cells;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const odd = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 1;
      const c = odd ? c2 : c1;
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// 程序化混凝土/岩石：底色 + 法线（由高度差求导）
export function stoneTexture(size = 512, seed = 7) {
  const color = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u * 6, v * 6, 4, seed);
      const grain = valueNoise(u * 90, v * 90, seed + 3) * 0.12;
      height[y * size + x] = n + grain;
      const shade = 0.42 + n * 0.28 + grain;
      const o = (y * size + x) * 4;
      color[o] = Math.min(255, shade * 230);
      color[o + 1] = Math.min(255, shade * 224);
      color[o + 2] = Math.min(255, shade * 214);
      color[o + 3] = 255;
    }
  }
  const strength = 2.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = height[y * size + ((x + size - 1) % size)];
      const xr = height[y * size + ((x + 1) % size)];
      const yu = height[((y + size - 1) % size) * size + x];
      const yd = height[((y + 1) % size) * size + x];
      let nx = (xl - xr) * strength;
      let ny = (yu - yd) * strength;
      let nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const o = (y * size + x) * 4;
      normal[o] = (nx * 0.5 + 0.5) * 255;
      normal[o + 1] = (ny * 0.5 + 0.5) * 255;
      normal[o + 2] = (nz * 0.5 + 0.5) * 255;
      normal[o + 3] = 255;
    }
  }
  return { color, normal, width: size, height: size };
}

// 金属腐蚀贴图：R=无意义 G=粗糙度 B=金属度
export function metalTexture(size = 256, seed = 11) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = fbm(u * 8, v * 8, 4, seed);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = Math.max(0, Math.min(255, (0.25 + n * 0.6) * 255));
      data[o + 2] = Math.max(0, Math.min(255, (n > 0.52 ? 0.9 : 0.15) * 255));
      data[o + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// 从 ImageData / Image 创建纹理（浏览器端）
export function uploadImageTexture(ctx, image, { mipmap = true, srgb = false } = {}) {
  const { gl } = ctx;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const pot = isPowerOfTwo(image.width) && isPowerOfTwo(image.height);
  if (mipmap && pot) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (ctx.anisoMax > 1) {
      gl.texParameterf(gl.TEXTURE_2D, ctx.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, ctx.anisoMax));
    }
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

function isPowerOfTwo(n) {
  return (n & (n - 1)) === 0 && n > 0;
}

export function uploadRawTexture(ctx, { width, height, data }, { mipmap = true, srgb = false } = {}) {
  const { gl } = ctx;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (mipmap && isPowerOfTwo(width) && isPowerOfTwo(height)) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    if (ctx.anisoMax > 1) {
      gl.texParameterf(gl.TEXTURE_2D, ctx.ext.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(4, ctx.anisoMax));
    }
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}

void mulberry32;
