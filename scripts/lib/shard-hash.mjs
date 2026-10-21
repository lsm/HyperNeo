import { readFileSync } from 'node:fs';

function update(crc, byte) {
  crc ^= byte << 24;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

const output = [];
for (const path of readFileSync(0, 'utf8').split('\0')) {
  if (!path) continue;
  const bytes = Buffer.from(path);
  let crc = 0;
  for (const byte of bytes) crc = update(crc, byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) {
    crc = update(crc, length & 255);
  }
  const checksum = (~crc >>> 0).toString().padStart(10, '0');
  output.push(`${checksum}\t${path}\n`);
}
process.stdout.write(output.join(''));
