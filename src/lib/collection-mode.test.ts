import { afterEach, expect, test, vi } from 'vitest';
import { parseCollectionMode } from '@/tracker/collection-mode';
import { register } from '../instrumentation';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('missing collection mode preserves standard behavior', () => {
  expect(parseCollectionMode(undefined)).toBe('standard');
  expect(parseCollectionMode(null)).toBe('standard');
});

test.each(['standard', 'anonymous'])('accepts collection mode %s at startup', mode => {
  vi.stubEnv('COLLECTION_MODE', mode);
  expect(parseCollectionMode(mode)).toBe(mode);
  expect(() => register()).not.toThrow();
});

test.each(['', 'ANONYMOUS', ' anonymous ', 'invalid'])(
  'invalid collection mode %j terminates Node startup',
  mode => {
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('COLLECTION_MODE', mode);
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('stopped');
    });
    expect(() => register()).toThrow('stopped');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      'COLLECTION_MODE must be one of: standard, anonymous.',
    );
  },
);
