import { describe, expect, test, vi } from 'vitest';
import { decrypt, encrypt, getSalt, hash, md5, uuid } from './crypto';

describe('encrypt/decrypt', () => {
  test('round-trips a value with the same secret', () => {
    const secret = 'my-secret';
    const value = 'hello world';

    const encrypted = encrypt(value, secret);

    expect(encrypted).not.toBe(value);
    expect(decrypt(encrypted, secret)).toBe(value);
  });

  test('produces different ciphertext on each call (random iv/salt)', () => {
    const secret = 'my-secret';

    expect(encrypt('same', secret)).not.toBe(encrypt('same', secret));
  });

  test('fails to decrypt with the wrong secret', () => {
    const encrypted = encrypt('secret data', 'right-secret');

    expect(() => decrypt(encrypted, 'wrong-secret')).toThrow();
  });

  test('fails to decrypt tampered ciphertext', () => {
    const secret = 'my-secret';
    const encrypted = encrypt('secret data', secret);

    const buf = Buffer.from(encrypted, 'base64');
    buf[buf.length - 1] ^= 0xff;
    const tampered = buf.toString('base64');

    expect(() => decrypt(tampered, secret)).toThrow();
  });
});

describe('hash', () => {
  test('is deterministic for the same input', () => {
    expect(hash('a', 'b', 'c')).toBe(hash('a', 'b', 'c'));
  });

  test('returns a 128-char sha512 hex string', () => {
    expect(hash('umami')).toMatch(/^[0-9a-f]{128}$/);
  });

  test('changes when input changes', () => {
    expect(hash('a')).not.toBe(hash('b'));
  });
});

describe('md5', () => {
  test('is deterministic for the same input', () => {
    expect(md5('a', 'b')).toBe(md5('a', 'b'));
  });

  test('returns a 32-char hex string', () => {
    expect(md5('umami')).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('rotation boundaries (current server-local calendar)', () => {
  test('daily salt stays stable throughout a local calendar day', () => {
    expect(getSalt('day', new Date(2026, 8, 15, 0, 0, 0))).toBe(
      getSalt('day', new Date(2026, 8, 15, 23, 59, 59, 999)),
    );
  });

  test.each([
    [2026, 8, 15],
    [2026, 8, 30],
    [2026, 11, 31],
    [2028, 1, 29],
  ])('daily salt changes at local midnight after %i/%i/%i', (year, month, day) => {
    expect(getSalt('day', new Date(year, month, day, 23, 59, 59, 999))).not.toBe(
      getSalt('day', new Date(year, month, day + 1)),
    );
  });

  test.each([
    [2026, 2, 8],
    [2026, 10, 1],
  ])('daily salt spans the local DST transition day %i/%i/%i', (year, month, day) => {
    const midnight = getSalt('day', new Date(year, month, day));
    expect(getSalt('day', new Date(year, month, day, 1, 30))).toBe(midnight);
    expect(getSalt('day', new Date(year, month, day, 3, 30))).toBe(midnight);
    expect(getSalt('day', new Date(year, month, day, 23, 59))).toBe(midnight);
    expect(getSalt('day', new Date(year, month, day + 1))).not.toBe(midnight);
  });

  test('monthly salt survives a day boundary but changes at the next month', () => {
    const first = getSalt('month', new Date(2026, 8, 15));
    expect(getSalt('month', new Date(2026, 8, 16))).toBe(first);
    expect(getSalt('month', new Date(2026, 9, 1))).not.toBe(first);
  });

  test('unrecognized rotation settings currently fall back to monthly', () => {
    const date = new Date(2026, 8, 15);
    expect(getSalt('daily', date)).toBe(getSalt('month', date));
  });
});

describe('uuid', () => {
  test('returns a v4 uuid with no args', () => {
    vi.stubEnv('USE_UUIDV7', '');

    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    vi.unstubAllEnvs();
  });

  test('is deterministic (v5) for the same args', () => {
    vi.stubEnv('APP_SECRET', 'test-secret');

    expect(uuid('a', 'b')).toBe(uuid('a', 'b'));

    vi.unstubAllEnvs();
  });

  test('differs for different args', () => {
    vi.stubEnv('APP_SECRET', 'test-secret');

    expect(uuid('a')).not.toBe(uuid('b'));

    vi.unstubAllEnvs();
  });
});
