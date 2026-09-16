import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Set a deterministic secret before anything reads it so that real crypto/jwt
// helpers used by the route and by the test produce matching tokens.
process.env.APP_SECRET = 'route-send-test-secret';

import { isbot } from 'isbot';
import clickhouse from '@/lib/clickhouse';
import { CACHE_TOKEN_TYPE, EVENT_TYPE } from '@/lib/constants';
import { getSalt, secret, uuid } from '@/lib/crypto';
import { getClientInfo, hasBlockedIp } from '@/lib/detect';
import { createToken, parseToken } from '@/lib/jwt';
import { fetchWebsite } from '@/lib/load';
import { parseRequest } from '@/lib/request';
import {
  createSession,
  saveEvent,
  saveSessionData,
  saveSessionLink,
  updateSession,
} from '@/queries/sql';
import { POST } from './route';

vi.mock('@/lib/clickhouse', () => ({ default: { enabled: false } }));

vi.mock('@/lib/detect', () => ({
  getClientInfo: vi.fn(),
  hasBlockedIp: vi.fn(),
}));

vi.mock('@/lib/load', () => ({
  fetchWebsite: vi.fn(),
}));

vi.mock('@/lib/request', () => ({
  parseRequest: vi.fn(),
}));

vi.mock('@/queries/sql', () => ({
  createSession: vi.fn(),
  saveEvent: vi.fn(),
  saveSessionData: vi.fn(),
  saveSessionLink: vi.fn(),
  updateSession: vi.fn(),
}));

vi.mock('isbot', () => ({
  isbot: vi.fn(),
}));

const parseRequestMock = vi.mocked(parseRequest);
const getClientInfoMock = vi.mocked(getClientInfo);
const hasBlockedIpMock = vi.mocked(hasBlockedIp);
const fetchWebsiteMock = vi.mocked(fetchWebsite);
const isbotMock = vi.mocked(isbot);
const createSessionMock = vi.mocked(createSession);
const saveEventMock = vi.mocked(saveEvent);
const saveSessionDataMock = vi.mocked(saveSessionData);
const saveSessionLinkMock = vi.mocked(saveSessionLink);
const updateSessionMock = vi.mocked(updateSession);

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_WEBSITE_ID = '44444444-4444-4444-8444-444444444444';
const LINK_ID = '22222222-2222-4222-8222-222222222222';
const PIXEL_ID = '33333333-3333-4333-8333-333333333333';

const defaultClientInfo = {
  ip: '203.0.113.5',
  userAgent: 'Mozilla/5.0',
  device: 'desktop',
  browser: 'chrome',
  os: 'Windows 10',
  country: 'US',
  region: 'US-CA',
  city: 'San Francisco',
};

/**
 * Drives POST by making parseRequest resolve to the given body. Because the
 * route calls parseRequest(request, schema, ...), the schema is still captured
 * on the mock for direct schema assertions.
 */
function callPOST(
  { type, payload }: { type: string; payload: Record<string, any> },
  { headers }: { headers?: Record<string, string> } = {},
) {
  parseRequestMock.mockResolvedValue({ body: { type, payload }, error: undefined });

  return POST(
    new Request('http://localhost/api/send', {
      method: 'POST',
      headers,
    }),
  );
}

function makeComputedSessionId(sourceId: string, timestamp = Math.floor(Date.now() / 1000)) {
  const createdAt = new Date(timestamp * 1000);
  const sessionSalt = getSalt(process.env.SALT_ROTATION || 'month', createdAt);

  return uuid(sourceId, defaultClientInfo.ip, defaultClientInfo.userAgent, sessionSalt);
}

beforeEach(() => {
  vi.clearAllMocks();
  (clickhouse as any).enabled = false;
  delete process.env.DISABLE_BOT_CHECK;
  delete process.env.REMOVE_TRAILING_SLASH;
  delete process.env.SALT_ROTATION;

  isbotMock.mockReturnValue(false);
  hasBlockedIpMock.mockReturnValue(false);
  fetchWebsiteMock.mockResolvedValue({ id: WEBSITE_ID } as any);
  getClientInfoMock.mockResolvedValue({ ...defaultClientInfo } as any);
  createSessionMock.mockResolvedValue(undefined as any);
  saveEventMock.mockResolvedValue(undefined as any);
  saveSessionDataMock.mockResolvedValue(undefined as any);
  saveSessionLinkMock.mockResolvedValue(undefined as any);
  updateSessionMock.mockResolvedValue(undefined as any);
});

describe('parseRequest error handling', () => {
  test('returns the parseRequest error response and does not process the event', async () => {
    parseRequestMock.mockResolvedValue({
      body: undefined,
      error: () => Response.json({ error: { code: 'bad-request', status: 400 } }, { status: 400 }),
    });

    const response = await POST(new Request('http://localhost/api/send', { method: 'POST' }));

    expect(response.status).toBe(400);
    expect(saveEventMock).not.toHaveBeenCalled();
    expect(getClientInfoMock).not.toHaveBeenCalled();
  });

  test('calls parseRequest with skipAuth so tracker requests are unauthenticated', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(parseRequestMock.mock.calls[0][2]).toEqual({ skipAuth: true });
  });
});

describe('schema validation', () => {
  // The schema is passed to parseRequest; grab it and exercise safeParse directly.
  async function getSchema() {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });
    return parseRequestMock.mock.calls[0][1] as {
      safeParse: (value: unknown) => { success: boolean };
    };
  }

  test('rejects an invalid type enum value', async () => {
    const schema = await getSchema();

    expect(schema.safeParse({ type: 'bogus', payload: { website: WEBSITE_ID } }).success).toBe(
      false,
    );
    expect(schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ type: 'identify', payload: { website: WEBSITE_ID } }).success).toBe(
      true,
    );
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID } }).success,
    ).toBe(true);
  });

  test('requires exactly one of website, link, or pixel', async () => {
    const schema = await getSchema();

    // zero set -> invalid
    expect(schema.safeParse({ type: 'event', payload: {} }).success).toBe(false);
    // one set -> valid
    expect(schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID } }).success).toBe(
      true,
    );
    expect(schema.safeParse({ type: 'event', payload: { link: LINK_ID } }).success).toBe(true);
    expect(schema.safeParse({ type: 'event', payload: { pixel: PIXEL_ID } }).success).toBe(true);
    // two set -> invalid
    expect(
      schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, link: LINK_ID } }).success,
    ).toBe(false);
    // all three set -> invalid
    expect(
      schema.safeParse({
        type: 'event',
        payload: { website: WEBSITE_ID, link: LINK_ID, pixel: PIXEL_ID },
      }).success,
    ).toBe(false);
  });

  test('rejects CSV formula injection triggers in name and tag', async () => {
    const schema = await getSchema();

    for (const bad of ['=1+1', '+cmd', '-2', '@SUM', '\tvalue', '\rvalue']) {
      expect(
        schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, name: bad } }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, tag: bad } }).success,
      ).toBe(false);
    }

    // A safe leading character passes.
    expect(
      schema.safeParse({ type: 'event', payload: { website: WEBSITE_ID, name: 'signup' } }).success,
    ).toBe(true);
  });

  test('enforces web vitals numeric bounds', async () => {
    const schema = await getSchema();

    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, lcp: -1 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, lcp: 60001 } })
        .success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, cls: 101 } }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ type: 'performance', payload: { website: WEBSITE_ID, lcp: 2500 } })
        .success,
    ).toBe(true);
  });
});

describe('bot detection gate', () => {
  test('returns a 200 no-op response for bots and skips persistence', async () => {
    isbotMock.mockReturnValue(true);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ beep: 'boop' });
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('DISABLE_BOT_CHECK bypasses the bot gate', async () => {
    process.env.DISABLE_BOT_CHECK = '1';
    isbotMock.mockReturnValue(true);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.not.toEqual({ beep: 'boop' });
    expect(saveEventMock).toHaveBeenCalledTimes(1);
    expect(isbotMock).not.toHaveBeenCalled();
  });
});

describe('IP blocklist', () => {
  test('returns 403 when the client IP is blocked', async () => {
    hasBlockedIpMock.mockReturnValue(true);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'forbidden', status: 403 },
    });
    expect(saveEventMock).not.toHaveBeenCalled();
  });
});

describe('website lookup', () => {
  test('returns 400 when the website does not exist', async () => {
    fetchWebsiteMock.mockResolvedValue(null as any);

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { message: 'Website not found.', status: 400 },
    });
    expect(saveEventMock).not.toHaveBeenCalled();
  });

  test('does not look up a website for link events', async () => {
    await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });

    expect(fetchWebsiteMock).not.toHaveBeenCalled();
  });
});

describe('session creation', () => {
  test('creates a session when clickhouse is disabled and there is no cache', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      browser: 'chrome',
      os: 'Windows 10',
      device: 'desktop',
    });
  });

  test('does not create a session when clickhouse is enabled', async () => {
    (clickhouse as any).enabled = true;

    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(createSessionMock).not.toHaveBeenCalled();
  });
});

describe('eventType selection ladder', () => {
  test('link events use the linkEvent type', async () => {
    await callPOST({ type: 'event', payload: { link: LINK_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.linkEvent });
  });

  test('pixel events use the pixelEvent type', async () => {
    await callPOST({ type: 'event', payload: { pixel: PIXEL_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.pixelEvent });
  });

  test('named website events use the customEvent type', async () => {
    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/', name: 'signup' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      eventType: EVENT_TYPE.customEvent,
      eventName: 'signup',
    });
  });

  test('unnamed website events use the pageView type', async () => {
    await callPOST({ type: 'event', payload: { website: WEBSITE_ID, url: '/' } });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ eventType: EVENT_TYPE.pageView });
  });
});

describe('event url and referrer parsing', () => {
  test('extracts url path, query, domain and referrer fields', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products?utm_source=news&gclid=abc',
        referrer: 'https://www.google.com/search?q=umami',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      hostname: 'example.com',
      urlPath: '/products',
      urlQuery: 'utm_source=news&gclid=abc',
      utmSource: 'news',
      gclid: 'abc',
      referrerPath: '/search',
      referrerQuery: 'q=umami',
      referrerDomain: 'google.com',
    });
  });

  test('does not save referrer domain when it matches the hostname', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: 'https://www.example.com/prev?a=1',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      referrerPath: '/prev',
      referrerQuery: 'a=1',
    });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain for a path-only referrer', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: '/prev?a=1',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({
      referrerPath: '/prev',
      referrerQuery: 'a=1',
    });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('saves referrer domain for a lookalike domain that only shares a prefix', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/products',
        referrer: 'https://example.com.br/page',
      },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      referrerDomain: 'example.com.br',
      referrerPath: '/page',
    });
  });

  test('resolves a path-only referrer against the url domain when hostname is missing', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        url: 'https://example.com/products',
        referrer: '/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain when hostname differs only by case', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'EXAMPLE.com',
        url: '/products',
        referrer: 'https://example.com/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('does not save referrer domain when hostname includes a port', async () => {
    await callPOST({
      type: 'event',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com:8443',
        url: '/products',
        referrer: 'https://example.com:8443/prev',
      },
    });

    const arg = saveEventMock.mock.calls[0][0] as Record<string, any>;
    expect(arg).toMatchObject({ referrerPath: '/prev' });
    expect(arg.referrerDomain).toBeUndefined();
  });

  test('REMOVE_TRAILING_SLASH strips a trailing slash from the url path', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/blog/' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/blog' });
  });

  test('REMOVE_TRAILING_SLASH keeps the root path as "/"', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/' });
  });

  test('REMOVE_TRAILING_SLASH keeps the root path when the url has a hash', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/#hero' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/#hero' });
  });

  test('REMOVE_TRAILING_SLASH strips a trailing slash before the hash', async () => {
    process.env.REMOVE_TRAILING_SLASH = '1';

    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/blog/#hero' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '/blog#hero' });
  });

  test('maps a "/undefined" pathname to an empty url path', async () => {
    await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, hostname: 'example.com', url: '/undefined' },
    });

    expect(saveEventMock.mock.calls[0][0]).toMatchObject({ urlPath: '' });
  });
});

describe('cache token handling', () => {
  function makeCacheToken(overrides: Record<string, any> = {}) {
    return createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: 'cached-session',
        visitId: 'cached-visit',
        iat: Math.floor(Date.now() / 1000),
        ...overrides,
      },
      secret(),
    );
  }

  test('a valid cache token skips website lookup and session creation when it matches the computed session', async () => {
    const timestamp = 1704067200;
    const token = makeCacheToken({ sessionId: makeComputedSessionId(WEBSITE_ID, timestamp) });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', timestamp } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ visitId: 'cached-visit' });
  });

  test.each(['event', 'identify', 'performance'])(
    "%s validates the requested website and discards another website's cached state",
    async type => {
      const token = makeCacheToken({ sessionLinkId: 'other-website-link' });
      fetchWebsiteMock.mockResolvedValue({ id: OTHER_WEBSITE_ID } as any);

      const response = await callPOST(
        {
          type,
          payload: { website: OTHER_WEBSITE_ID, url: '/', data: { plan: 'free' } },
        },
        { headers: { 'x-umami-cache': token } },
      );

      expect(response.status).toBe(200);
      expect(fetchWebsiteMock).toHaveBeenCalledExactlyOnceWith(OTHER_WEBSITE_ID);
      const body = await response.json();
      expect(createSessionMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: body.sessionId, websiteId: OTHER_WEBSITE_ID }),
      );
      const write = type === 'identify' ? saveSessionDataMock : saveEventMock;
      expect(write).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: body.sessionId, websiteId: OTHER_WEBSITE_ID }),
      );
      expect(fetchWebsiteMock.mock.invocationCallOrder[0]).toBeLessThan(
        createSessionMock.mock.invocationCallOrder[0],
      );
      expect(createSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
        write.mock.invocationCallOrder[0],
      );
      expect(body.sessionId).not.toBe('cached-session');
      expect(body.visitId).not.toBe('cached-visit');
      const replacement = parseToken(body.cache, secret());
      expect(replacement).toMatchObject({
        websiteId: OTHER_WEBSITE_ID,
        sessionId: body.sessionId,
        visitId: body.visitId,
      });
      expect(replacement).not.toHaveProperty('sessionLinkId');
    },
  );

  test.each(['event', 'identify', 'performance'])(
    "%s rejects a nonexistent website even with another website's valid token",
    async type => {
      const token = makeCacheToken();
      fetchWebsiteMock.mockResolvedValue(null);

      const response = await callPOST(
        {
          type,
          payload: {
            website: OTHER_WEBSITE_ID,
            url: '/',
            id: 'customer-42',
            data: { plan: 'free' },
          },
        },
        { headers: { 'x-umami-cache': token } },
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: 'Website not found.' },
      });
      expect(fetchWebsiteMock).toHaveBeenCalledExactlyOnceWith(OTHER_WEBSITE_ID);
      expect(getClientInfoMock).not.toHaveBeenCalled();
      for (const write of [
        createSessionMock,
        saveEventMock,
        saveSessionDataMock,
        saveSessionLinkMock,
        updateSessionMock,
      ]) {
        expect(write).not.toHaveBeenCalled();
      }
    },
  );

  test('a token without a website cannot suppress session creation or supply cached state', async () => {
    const timestamp = 1704067200;
    const token = makeCacheToken({
      websiteId: undefined,
      sessionId: makeComputedSessionId(WEBSITE_ID, timestamp),
      sessionLinkId: 'unscoped-link',
    });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/', timestamp } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(response.status).toBe(200);
    expect(fetchWebsiteMock).toHaveBeenCalledExactlyOnceWith(WEBSITE_ID);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const body = await response.json();
    expect(body.visitId).not.toBe('cached-visit');
    expect(parseToken(body.cache, secret())).not.toHaveProperty('sessionLinkId');
  });

  test('a valid cache token creates the computed session before event writes when the cached session differs', async () => {
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const createdSession = createSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedEvent = saveEventMock.mock.calls[0][0] as Record<string, any>;
    const body = (await response.json()) as Record<string, any>;

    expect(createdSession.id).not.toBe('cached-session');
    expect(savedEvent.sessionId).toBe(createdSession.id);
    expect(savedEvent.visitId).not.toBe('cached-visit');
    expect(body.sessionId).toBe(createdSession.id);
    expect(body.visitId).toBe(savedEvent.visitId);
  });

  test('a valid cache token creates the computed session before identify writes when the cached session differs', async () => {
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'identify', payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    const createdSession = createSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedLink = saveSessionLinkMock.mock.calls[0][0] as Record<string, any>;
    const updatedSession = updateSessionMock.mock.calls[0][0] as Record<string, any>;
    const savedSessionData = saveSessionDataMock.mock.calls[0][0] as Record<string, any>;
    const body = (await response.json()) as Record<string, any>;

    expect(createdSession.id).not.toBe('cached-session');
    expect(savedLink.sessionId).toBe(createdSession.id);
    expect(updatedSession.sessionId).toBe(createdSession.id);
    expect(savedSessionData.sessionId).toBe(createdSession.id);
    expect(body.sessionId).toBe(createdSession.id);
    expect(body.visitId).not.toBe('cached-visit');
  });

  test('a drifted cache token resets the visit in clickhouse mode without creating a session row', async () => {
    (clickhouse as any).enabled = true;
    const token = makeCacheToken({ sessionId: 'cached-session' });

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    const savedEvent = saveEventMock.mock.calls[0][0] as Record<string, any>;
    const body = (await response.json()) as Record<string, any>;

    expect(createSessionMock).not.toHaveBeenCalled();
    expect(savedEvent.sessionId).toBe(body.sessionId);
    expect(savedEvent.visitId).not.toBe('cached-visit');
    expect(body.visitId).toBe(savedEvent.visitId);
  });

  test('an invalid cache token falls back to website lookup', async () => {
    await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': 'not-a-jwt' } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
  });

  test('a token with a non-cache type is ignored', async () => {
    const token = createToken(
      { type: 'share', websiteId: WEBSITE_ID, sessionId: 's', visitId: 'v', iat: 1 },
      secret(),
    );

    await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
  });

  test('an expired cache token is treated as absent', async () => {
    const token = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: 'cached-session',
        visitId: 'cached-visit',
      },
      secret(),
      { expiresIn: -10 },
    );

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(fetchWebsiteMock).toHaveBeenCalledTimes(1);
    // A fresh visitId is generated rather than reusing the token's value.
    await expect(response.json()).resolves.not.toMatchObject({ visitId: 'cached-visit' });
  });

  test('returns a signed cache token that round-trips to the response identifiers', async () => {
    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    const body = (await response.json()) as Record<string, any>;
    const decoded = parseToken(body.cache, secret()) as Record<string, any>;

    expect(decoded.type).toBe(CACHE_TOKEN_TYPE);
    expect(decoded.sessionId).toBe(body.sessionId);
    expect(decoded.visitId).toBe(body.visitId);
    expect(decoded.websiteId).toBe(WEBSITE_ID);
  });
});

describe('30-minute visit expiry', () => {
  test('regenerates the visit when the cached iat is older than 30 minutes', async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 2000;
    const token = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: makeComputedSessionId(WEBSITE_ID),
        visitId: 'cached-visit',
        iat: oldIat,
      },
      secret(),
    );

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    const body = (await response.json()) as Record<string, any>;
    expect(body.visitId).not.toBe('cached-visit');
  });

  test('keeps the cached visit when within the 30-minute window', async () => {
    const recentIat = Math.floor(Date.now() / 1000) - 100;
    const token = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: makeComputedSessionId(WEBSITE_ID),
        visitId: 'cached-visit',
        iat: recentIat,
      },
      secret(),
    );

    const response = await callPOST(
      { type: 'event', payload: { website: WEBSITE_ID, url: '/' } },
      { headers: { 'x-umami-cache': token } },
    );

    await expect(response.json()).resolves.toMatchObject({ visitId: 'cached-visit' });
  });

  test('does not expire the visit when an explicit timestamp is supplied', async () => {
    const timestamp = 1000000000;
    const oldIat = Math.floor(Date.now() / 1000) - 5000;
    const token = createToken(
      {
        type: CACHE_TOKEN_TYPE,
        websiteId: WEBSITE_ID,
        sessionId: makeComputedSessionId(WEBSITE_ID, timestamp),
        visitId: 'cached-visit',
        iat: oldIat,
      },
      secret(),
    );

    const response = await callPOST(
      {
        type: 'event',
        payload: { website: WEBSITE_ID, url: '/', timestamp },
      },
      { headers: { 'x-umami-cache': token } },
    );

    await expect(response.json()).resolves.toMatchObject({ visitId: 'cached-visit' });
  });
});

describe('visitor identity across requests (current behavior)', () => {
  beforeEach(() => {
    vi.stubEnv('SALT_ROTATION', 'day');
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  async function collect(
    at: Date,
    cache?: string,
    payload: Record<string, unknown> = {},
    type = 'event',
  ) {
    vi.setSystemTime(at);
    const response = await callPOST(
      { type, payload: { website: WEBSITE_ID, url: '/', ...payload } },
      { headers: cache ? { 'x-umami-cache': cache } : undefined },
    );
    expect(response.status).toBe(200);
    return response.json() as Promise<{ cache: string; sessionId: string; visitId: string }>;
  }

  test('reuses a matching daily session and visit without another session write', async () => {
    const first = await collect(new Date(2026, 8, 15, 12));
    const second = await collect(new Date(2026, 8, 15, 12, 1), first.cache);

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.visitId).toBe(first.visitId);
    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(saveEventMock).toHaveBeenCalledTimes(2);
  });

  test.each(['event', 'identify', 'performance'])(
    "%s replaces yesterday's cached session before writing at local midnight",
    async type => {
      const payload = type === 'identify' ? { data: { plan: 'free' } } : {};
      const first = await collect(new Date(2026, 8, 15, 23, 59, 59), undefined, payload, type);
      vi.clearAllMocks();
      const midnight = new Date(2026, 8, 16);
      const second = await collect(midnight, first.cache, payload, type);
      const write = type === 'identify' ? saveSessionDataMock : saveEventMock;

      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.visitId).not.toBe(first.visitId);
      expect(createSessionMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ id: second.sessionId, websiteId: WEBSITE_ID }),
      );
      expect(write).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ sessionId: second.sessionId }),
      );
      expect(createSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
        write.mock.invocationCallOrder[0],
      );
      expect(parseToken(second.cache, secret())).toMatchObject({
        websiteId: WEBSITE_ID,
        sessionId: second.sessionId,
        visitId: second.visitId,
        iat: midnight.getTime() / 1000,
      });
    },
  );

  test('daily IDs rotate without a cache token, including after a page reload', async () => {
    const first = await collect(new Date(2026, 8, 15, 12));
    const reload = await collect(new Date(2026, 8, 15, 12, 1));
    const nextDay = await collect(new Date(2026, 8, 16, 12));
    expect(reload.sessionId).toBe(first.sessionId);
    expect(nextDay.sessionId).not.toBe(first.sessionId);
  });

  test('the unchanged default keeps the visitor ID across days within a month', async () => {
    vi.stubEnv('SALT_ROTATION', undefined);
    const first = await collect(new Date(2026, 8, 15, 23, 59, 59));
    const nextDay = await collect(new Date(2026, 8, 16), first.cache);
    const nextMonth = await collect(new Date(2026, 9, 1), nextDay.cache);
    expect(nextDay.sessionId).toBe(first.sessionId);
    expect(nextMonth.sessionId).not.toBe(first.sessionId);
  });

  test('the same visitor receives different IDs for different websites', async () => {
    const at = new Date(2026, 8, 15, 12);
    const first = await collect(at);
    const second = await collect(at, undefined, { website: PIXEL_ID });
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(createSessionMock.mock.calls[1][0]).toMatchObject({
      id: second.sessionId,
      websiteId: PIXEL_ID,
    });
  });

  test.each([{ ip: '2001:db8::5' }, { userAgent: 'Another browser' }])(
    'changed client inputs rotate the session despite a cached token: %j',
    async changed => {
      const at = new Date(2026, 8, 15, 12);
      const first = await collect(at);
      getClientInfoMock.mockResolvedValue({ ...defaultClientInfo, ...changed } as any);
      const second = await collect(at, first.cache);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(second.visitId).not.toBe(first.visitId);
      expect(createSessionMock).toHaveBeenCalledTimes(2);
    },
  );

  test('changing the application secret invalidates the old token and visitor ID', async () => {
    const at = new Date(2026, 8, 15, 12);
    const first = await collect(at);
    vi.stubEnv('APP_SECRET', 'replacement-identity-review-secret');
    const second = await collect(at, first.cache);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(fetchWebsiteMock).toHaveBeenCalledTimes(2);
  });

  test('a supplied event timestamp selects its historical day rather than the receive day', async () => {
    const historical = new Date(2026, 8, 15, 12);
    const received = new Date(2026, 8, 17, 12);
    const first = await collect(historical);
    const backdated = await collect(received, undefined, {
      timestamp: historical.getTime() / 1000,
    });
    const current = await collect(received);
    expect(backdated.sessionId).toBe(first.sessionId);
    expect(current.sessionId).not.toBe(first.sessionId);
    expect(saveEventMock.mock.calls[1][0].createdAt).toEqual(historical);
  });

  test('explicit identify values remain linkable across daily rotation', async () => {
    const payload = { id: 'customer-42' };
    const first = await collect(new Date(2026, 8, 15, 23, 59, 59), undefined, payload, 'identify');
    const second = await collect(new Date(2026, 8, 16), first.cache, payload, 'identify');
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(saveSessionLinkMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sessionId: first.sessionId, distinctId: 'customer-42' }),
    );
    expect(saveSessionLinkMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: second.sessionId, distinctId: 'customer-42' }),
    );
    expect(updateSessionMock).toHaveBeenCalledTimes(2);
  });

  test('ordinary collection does not pass the raw IP to persistence or the cache token', async () => {
    const result = await collect(new Date(2026, 8, 15, 12));
    const session = createSessionMock.mock.calls[0][0];
    const event = saveEventMock.mock.calls[0][0];
    const token = parseToken(result.cache, secret());
    for (const value of [session, event, token]) {
      expect(value).not.toHaveProperty('ip');
      expect(JSON.stringify(value)).not.toContain(defaultClientInfo.ip);
    }
    expect(token).not.toHaveProperty('exp');
  });

  test('the 30-minute visit refresh currently reuses its ID within the same clock hour', async () => {
    const first = await collect(new Date(2026, 8, 15, 9));
    const second = await collect(new Date(2026, 8, 15, 9, 30, 1), first.cache);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.visitId).toBe(first.visitId);
    expect(parseToken(second.cache, secret())).toMatchObject({
      iat: new Date(2026, 8, 15, 9, 30, 1).getTime() / 1000,
    });
  });
});

describe('identify collection', () => {
  test('saves a session link and updates the session for a new distinctId', async () => {
    await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });

    expect(saveSessionLinkMock).toHaveBeenCalledTimes(1);
    expect(updateSessionMock).toHaveBeenCalledTimes(1);
    expect(saveSessionLinkMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      distinctId: 'user-42',
    });
  });

  test('saves session data when a data payload is present', async () => {
    await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });

    expect(saveSessionDataMock).toHaveBeenCalledTimes(1);
    expect(saveSessionDataMock.mock.calls[0][0]).toMatchObject({
      websiteId: WEBSITE_ID,
      sessionData: { plan: 'pro' },
    });
  });

  test('skips identity writes when the cached sessionLinkId already matches', async () => {
    // First identify establishes the link and returns a cache token carrying
    // the resulting sessionLinkId.
    const first = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42' },
    });
    const firstBody = (await first.json()) as Record<string, any>;
    const token = firstBody.cache;

    saveSessionLinkMock.mockClear();
    updateSessionMock.mockClear();

    // Replaying with that token should recognise the same identity and skip.
    await callPOST(
      { type: 'identify', payload: { website: WEBSITE_ID, id: 'user-42' } },
      { headers: { 'x-umami-cache': token } },
    );

    expect(saveSessionLinkMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  test('does not write identity records without a website id', async () => {
    await callPOST({
      type: 'identify',
      payload: { link: LINK_ID, id: 'user-42' },
    });

    expect(saveSessionLinkMock).not.toHaveBeenCalled();
    expect(updateSessionMock).not.toHaveBeenCalled();
  });

  test('identity link failures do not block session data writes', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    saveSessionLinkMock.mockRejectedValue(new Error('link failed'));

    const response = await callPOST({
      type: 'identify',
      payload: { website: WEBSITE_ID, id: 'user-42', data: { plan: 'pro' } },
    });

    expect(response.status).toBe(200);
    expect(saveSessionDataMock).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('performance collection', () => {
  test('saves a performance event with the web vitals metrics', async () => {
    await callPOST({
      type: 'performance',
      payload: {
        website: WEBSITE_ID,
        hostname: 'example.com',
        url: '/dashboard',
        lcp: 1200,
        inp: 50,
        cls: 0.05,
        fcp: 900,
        ttfb: 300,
      },
    });

    expect(saveEventMock).toHaveBeenCalledTimes(1);
    expect(saveEventMock.mock.calls[0][0]).toMatchObject({
      eventType: EVENT_TYPE.performance,
      urlPath: '/dashboard',
      lcp: 1200,
      inp: 50,
      cls: 0.05,
      fcp: 900,
      ttfb: 300,
    });
  });
});

describe('error handling', () => {
  test('returns a 500 server error when persistence throws', async () => {
    saveEventMock.mockRejectedValue(new Error('db down'));
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const response = await callPOST({
      type: 'event',
      payload: { website: WEBSITE_ID, url: '/' },
    });

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'server-error', status: 500 },
    });
    consoleLog.mockRestore();
  });
});
