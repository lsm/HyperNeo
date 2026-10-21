import { readFileSync } from 'node:fs';

function update(crc, byte) {
  crc ^= byte << 24;
  for (let bit = 0; bit < 8; bit++) {
    crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

const input = readFileSync(0);
const output = [];
for (let start = 0; start < input.length; ) {
  const delimiter = input.indexOf(0, start);
  const end = delimiter < 0 ? input.length : delimiter;
  const bytes = input.subarray(start, end);
  start = end + 1;
  if (!bytes.length) continue;
  let crc = 0;
  for (const byte of bytes) crc = update(crc, byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) {
    crc = update(crc, length & 255);
  }
  const checksum = (~crc >>> 0).toString().padStart(10, '0');
  output.push(Buffer.from(`${checksum}\t`), bytes, Buffer.from('\n'));
}
process.stdout.write(Buffer.concat(output));
