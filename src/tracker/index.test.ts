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

test.each(['object', 'function', 'callback'])(
  'anonymous tracker removes identity and timestamp from %s payloads after callbacks',
  async variant => {
    const overrides = { id: 'customer-42', timestamp: 1 };
    Object.assign(window, {
      privacyCallback: (_type: string, payload: object) => ({ ...payload, ...overrides }),
    });
    await load({
      'collection-mode': 'anonymous',
      ...(variant === 'callback' ? { 'before-send': 'privacyCallback' } : {}),
    });
    if (variant === 'object') await window.umami.track({ website, url: '/', ...overrides });
    if (variant === 'function') await window.umami.track(payload => ({ ...payload, ...overrides }));
    if (variant === 'callback') await window.umami.track('button');
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body).payload;
    expect(payload).not.toHaveProperty('id');
    expect(payload).not.toHaveProperty('timestamp');
  },
);

test('anonymous tracker suppresses identify and does not retain identity for later events', async () => {
  const callback = vi.fn((_type: string, payload: object) => payload);
  Object.assign(window, { privacyCallback: callback });
  await load({ 'collection-mode': 'anonymous', 'before-send': 'privacyCallback' });
  await window.umami.identify('customer-42', { plan: 'pro' });
  await window.umami.identify({ id: 'customer-42', plan: 'pro' });
  expect(fetchMock).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
  await window.umami.track('button');
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).payload).not.toHaveProperty('id');
});

test('standard tracker preserves identities and timestamps', async () => {
  await load({ 'collection-mode': 'standard' });
  await window.umami.identify('customer-42');
  const historicalPayload = { website, url: '/', timestamp: 1 };
  await window.umami.track(historicalPayload);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
    type: 'identify',
    payload: { id: 'customer-42' },
  });
  expect(JSON.parse(fetchMock.mock.calls[1][1].body).payload.timestamp).toBe(1);
});

test.each(['', 'ANONYMOUS', 'invalid'])(
  'invalid collection mode %j disables the tracker',
  async mode => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await load({ 'collection-mode': mode });
    expect(window.umami).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
  },
);
