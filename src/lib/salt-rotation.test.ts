import { afterEach, describe, expect, test, vi } from 'vitest';
import { register } from '../instrumentation';
import { parseSaltRotation } from './salt-rotation';

afterEach(() => vi.unstubAllEnvs());

describe('rotation configuration', () => {
  test('defaults to month only when absent', () => {
    expect(parseSaltRotation(undefined)).toBe('month');
  });

  test.each(['day', 'week', 'month'])('accepts %s', value => {
    expect(parseSaltRotation(value)).toBe(value);
    vi.stubEnv('SALT_ROTATION', value);
    expect(() => register()).not.toThrow();
  });

  test.each(['', 'daily', 'DAY', ' day ', 'year'])(
    'rejects invalid setting %j at startup',
    value => {
      vi.stubEnv('SALT_ROTATION', value);
      expect(() => register()).toThrow('SALT_ROTATION must be one of: day, week, month.');
      expect(() => parseSaltRotation(value)).toThrow('SALT_ROTATION');
    },
  );
});
