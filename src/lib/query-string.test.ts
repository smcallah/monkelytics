import { afterEach, expect, test, vi } from 'vitest';
import { register } from '../instrumentation';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test.each([
  ['invalid', ''],
  ['', ''],
  ['allowlist', 'gclid'],
  ['preserve', 'utm_source'],
])('invalid query policy %j / %j stops Node startup', (mode, allowed) => {
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
  vi.stubEnv('QUERY_STRING_POLICY', mode);
  vi.stubEnv('QUERY_STRING_ALLOWLIST', allowed);
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('stopped');
  });
  expect(() => register()).toThrow('stopped');
  expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(diagnostic.mock.calls[0][0]).toContain('QUERY_STRING_');
});
