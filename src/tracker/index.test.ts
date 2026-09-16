import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const fetchMock = vi.fn();
const website = '11111111-1111-4111-8111-111111111111';
const rawUrl = 'https://example.com/path?token=secret&utm_source=news&gclid=click#secret';
const rawReferrer = 'https://other.test/prev?token=secret&utm_source=ref#secret';

beforeEach(() => {
  vi.resetModules();
  Reflect.deleteProperty(window, 'umami');
  fetchMock.mockReset().mockResolvedValue({ json: async () => ({ cache: 'cache' }) });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  Reflect.deleteProperty(window, 'umami');
  Reflect.deleteProperty(window, 'privacyCallback');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function load(attributes: Record<string, string> = {}) {
  const script = document.createElement('script');
  script.src = 'https://analytics.test/script.js';
  script.setAttribute('data-website-id', '11111111-1111-4111-8111-111111111111');
  script.setAttribute('data-auto-track', 'false');
  for (const [name, value] of Object.entries(attributes))
    script.setAttribute(`data-${name}`, value);
  vi.spyOn(document, 'currentScript', 'get').mockReturnValue(script);
  await import('./index');
}

test('default tracker preserves manual URLs and existing fetch behavior', async () => {
  await load();
  await window.umami.track({ website, url: rawUrl, referrer: rawReferrer });
  const options = fetchMock.mock.calls[0][1];
  expect(JSON.parse(options.body).payload).toMatchObject({ url: rawUrl, referrer: rawReferrer });
  expect(options.referrerPolicy).toBeUndefined();
});

test.each(['object', 'function', 'callback', 'identify'])(
  'privacy applies to %s payloads immediately before fetch',
  async variant => {
    Object.assign(window, {
      privacyCallback: (_type: string, payload: object) => ({
        ...payload,
        url: rawUrl,
        referrer: rawReferrer,
      }),
    });
    await load({
      'query-string-policy': 'allowlist',
      'query-string-allowlist': 'utm_source',
      ...(variant === 'callback' || variant === 'identify'
        ? { 'before-send': 'privacyCallback' }
        : {}),
    });
    if (variant === 'object')
      await window.umami.track({ website, url: rawUrl, referrer: rawReferrer });
    if (variant === 'function')
      await window.umami.track(payload => ({ ...payload, url: rawUrl, referrer: rawReferrer }));
    if (variant === 'callback') await window.umami.track('purchase');
    if (variant === 'identify') await window.umami.identify('existing-explicit-id');
    const options = fetchMock.mock.calls[0][1];
    expect(JSON.parse(options.body).payload).toMatchObject({
      url: 'https://example.com/path?utm_source=news',
      referrer: 'https://other.test/prev',
    });
    expect(options.body).not.toContain('secret');
    expect(options.body).not.toContain('gclid');
    expect(options.referrerPolicy).toBe('no-referrer');
  },
);

test('invalid configuration disables tracking instead of silently preserving queries', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await load({ 'query-string-policy': 'allowlist', 'query-string-allowlist': 'gclid' });
  expect(window.umami).toBeUndefined();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledOnce();
});

test('malformed manual URL is not transmitted', async () => {
  await load({ 'query-string-policy': 'allowlist' });
  await window.umami.track({ website, url: 'https://[invalid?token=secret' });
  expect(fetchMock).not.toHaveBeenCalled();
});
