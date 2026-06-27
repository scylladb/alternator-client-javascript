const MASK_64 = (1n << 64n) - 1n;
const SIGN_BIT = 1n << 63n;

const C1 = 0x87c37b91114253d5n;
const C2 = 0x4cf5ad432745937fn;
const FMIX1 = 0xff51afd7ed558ccdn;
const FMIX2 = 0xc4ceb9fe1a85ec53n;

export function murmur3H1(data: Uint8Array): bigint {
  let h1 = 0n;
  let h2 = 0n;

  const blockCount = Math.floor(data.byteLength / 16);
  for (let block = 0; block < blockCount; block += 1) {
    let k1 = readInt64LE(data, block * 16);
    let k2 = readInt64LE(data, block * 16 + 8);

    k1 = mul64(k1, C1);
    k1 = rotl64(k1, 31n);
    k1 = mul64(k1, C2);
    h1 = xor64(h1, k1);

    h1 = rotl64(h1, 27n);
    h1 = add64(h1, h2);
    h1 = add64(mul64(h1, 5n), 0x52dce729n);

    k2 = mul64(k2, C2);
    k2 = rotl64(k2, 33n);
    k2 = mul64(k2, C1);
    h2 = xor64(h2, k2);

    h2 = rotl64(h2, 31n);
    h2 = add64(h2, h1);
    h2 = add64(mul64(h2, 5n), 0x38495ab5n);
  }

  const tail = data.subarray(blockCount * 16);
  let k1 = 0n;
  let k2 = 0n;

  for (let index = 8; index < tail.length; index += 1) {
    k2 = xor64(k2, BigInt(tail[index] ?? 0) << BigInt((index - 8) * 8));
  }
  if (tail.length > 8) {
    k2 = mul64(k2, C2);
    k2 = rotl64(k2, 33n);
    k2 = mul64(k2, C1);
    h2 = xor64(h2, k2);
  }

  for (let index = 0; index < Math.min(8, tail.length); index += 1) {
    k1 = xor64(k1, BigInt(tail[index] ?? 0) << BigInt(index * 8));
  }
  if (tail.length > 0) {
    k1 = mul64(k1, C1);
    k1 = rotl64(k1, 31n);
    k1 = mul64(k1, C2);
    h1 = xor64(h1, k1);
  }

  h1 = xor64(h1, BigInt(data.byteLength));
  h2 = xor64(h2, BigInt(data.byteLength));

  h1 = add64(h1, h2);
  h2 = add64(h2, h1);

  h1 = fmix(h1);
  h2 = fmix(h2);

  return toSigned64(add64(h1, h2));
}

function fmix(value: bigint): bigint {
  let n = value;
  n = xor64(n, n >> 33n);
  n = mul64(n, FMIX1);
  n = xor64(n, n >> 33n);
  n = mul64(n, FMIX2);
  n = xor64(n, n >> 33n);
  return n;
}

function readInt64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) {
    value |= BigInt(data[offset + index] ?? 0) << BigInt(index * 8);
  }
  return value;
}

function add64(a: bigint, b: bigint): bigint {
  return (a + b) & MASK_64;
}

function mul64(a: bigint, b: bigint): bigint {
  return (a * b) & MASK_64;
}

function xor64(a: bigint, b: bigint): bigint {
  return (a ^ b) & MASK_64;
}

function rotl64(value: bigint, rotate: bigint): bigint {
  return ((value << rotate) | (value >> (64n - rotate))) & MASK_64;
}

function toSigned64(value: bigint): bigint {
  return value >= SIGN_BIT ? value - (1n << 64n) : value;
}
