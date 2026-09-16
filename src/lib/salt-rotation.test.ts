import { afterEach, describe, expect, test, vi } from 'vitest';
import { register } from '../instrumentation';
import { parseSaltRotation } from './salt-rotation';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('rotation configuration', () => {
  test('invalid configuration terminates Node startup instead of leaving a listener alive', () => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('SALT_ROTATION', 'daily');
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('startup stopped');
    });

    expect(() => register()).toThrow('startup stopped');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      'SALT_ROTATION must be one of: day, week, month.',
    );
  });

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
