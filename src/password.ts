import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const keyLength = 64;
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, stored?: string | null) {
  const parts = stored?.match(/^scrypt:([0-9a-f]{32}):([0-9a-f]{128})$/);
  const salt = parts ? Buffer.from(parts[1], "hex") : Buffer.alloc(16);
  const expected = parts
    ? Buffer.from(parts[2], "hex")
    : Buffer.alloc(keyLength);
  const key = await derive(password, salt);
  return timingSafeEqual(expected, key) && !!parts;
}
