const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([len, name, data, crc]);
}

function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    rgba.copy(raw, row + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function draw(size, theme) {
  const data = Buffer.alloc(size * size * 4);
  const fg = theme === 'dark' ? [235, 245, 255] : [32, 43, 57];
  const accent = theme === 'dark' ? [72, 191, 227] : [0, 122, 204];
  const warning = theme === 'dark' ? [255, 197, 84] : [221, 126, 16];

  function setPixel(x, y, color, alpha = 255) {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    data[i] = color[0];
    data[i + 1] = color[1];
    data[i + 2] = color[2];
    data[i + 3] = alpha;
  }

  function line(x0, y0, x1, y1, color, width = 2) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i += 1) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      for (let oy = -Math.floor(width / 2); oy <= Math.floor(width / 2); oy += 1) {
        for (let ox = -Math.floor(width / 2); ox <= Math.floor(width / 2); ox += 1) {
          setPixel(x + ox, y + oy, color);
        }
      }
    }
  }

  function circle(cx, cy, radius, color, width = 2) {
    const inner = radius - width;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius && d >= inner) {
          setPixel(x, y, color);
        }
      }
    }
  }

  function filledCircle(cx, cy, radius, color) {
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y += 1) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x += 1) {
        if (Math.hypot(x - cx, y - cy) <= radius) {
          setPixel(x, y, color);
        }
      }
    }
  }

  const scale = size / 64;
  const s = (v) => Math.round(v * scale);
  circle(s(31), s(31), s(20), fg, Math.max(2, s(4)));
  line(s(44), s(12), s(54), s(12), accent, Math.max(2, s(4)));
  line(s(54), s(12), s(54), s(22), accent, Math.max(2, s(4)));
  line(s(53), s(12), s(45), s(20), accent, Math.max(2, s(4)));
  line(s(18), s(34), s(27), s(43), fg, Math.max(2, s(5)));
  line(s(27), s(43), s(47), s(21), fg, Math.max(2, s(5)));
  filledCircle(s(49), s(48), s(7), warning);
  line(s(49), s(44), s(49), s(50), theme === 'dark' ? [38, 38, 38] : [255, 255, 255], Math.max(1, s(2)));
  filledCircle(s(49), s(53), Math.max(1, s(1.5)), theme === 'dark' ? [38, 38, 38] : [255, 255, 255]);
  return data;
}

for (const theme of ['dark', 'light']) {
  fs.writeFileSync(path.join(outDir, 'icons', `problems-cleaner-${theme}.png`), png(64, 64, draw(64, theme)));
}

fs.writeFileSync(path.join(outDir, 'icon.png'), png(128, 128, draw(128, 'dark')));
