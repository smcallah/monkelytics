import { describe, expect, test } from 'vitest';
import { filterQueryString, parseQueryStringPolicy } from './query-string';

describe('query string policy', () => {
  test('preserves existing URL bytes when no policy is configured', () => {
    const url = new URL('https://example.com/p?a=%20&gclid=abc#section');
    expect(filterQueryString(url, parseQueryStringPolicy()).href).toBe(url.href);
  });

  test('allowlist mode with no approved parameters drops all queries and fragments', () => {
    const url = new URL('https://user:password@example.com/p?utm_source=news&email=secret#token');
    expect(filterQueryString(url, parseQueryStringPolicy('allowlist')).href).toBe(
      'https://example.com/p',
    );
    expect(url.search).toContain('email=secret');
  });

  test('only exact decoded approved names survive, including repeated approved parameters', () => {
    const url = new URL(
      'https://example.com/p?%75tm_source=news&utm_source=two&UTM_SOURCE=no&utm_campaign=launch&gclid=secret&email=a&%2575tm_source=hidden#secret',
    );
    expect(
      filterQueryString(url, parseQueryStringPolicy('allowlist', 'utm_source, utm_campaign'))
        .search,
    ).toBe('?utm_source=news&utm_source=two&utm_campaign=launch');
  });

  test('referrers never retain even approved campaign parameters', () => {
    expect(
      filterQueryString(
        new URL('https://other.test/?utm_source=news#token'),
        parseQueryStringPolicy('allowlist', 'utm_source'),
        true,
      ).href,
    ).toBe('https://other.test/');
  });

  test.each(['', 'ALLOWLIST', 'strip', ' allowlist '])('rejects invalid mode %j', mode => {
    expect(() => parseQueryStringPolicy(mode)).toThrow('QUERY_STRING_POLICY');
  });

  test.each(['gclid', 'email', 'utm_source,', 'UTM_SOURCE', 'utm_campaign,gclid', '*', ' '])(
    'rejects invalid allowlist %j',
    allowed => {
      expect(() => parseQueryStringPolicy('allowlist', allowed)).toThrow('QUERY_STRING_ALLOWLIST');
    },
  );

  test('rejects an allowlist when preservation is still configured', () => {
    expect(() => parseQueryStringPolicy(undefined, 'utm_source')).toThrow('requires');
  });
});
