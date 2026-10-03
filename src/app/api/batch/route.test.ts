import { beforeEach, expect, test, vi } from 'vitest';
import * as send from '@/app/api/send/route';
import { parseRequest } from '@/lib/request';
import { POST } from './route';

vi.mock('@/app/api/send/route', () => ({ POST: vi.fn() }));
vi.mock('@/lib/request', () => ({ parseRequest: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

test('batches report indexed observation diagnostics separately from rejected items', async () => {
  vi.mocked(parseRequest).mockResolvedValue({ body: [{}, {}, {}], error: undefined } as any);
  const validation = { mode: 'observe', issues: [{ code: 'undeclared_event' }] };
  const rejection = {
    error: {
      validation: { mode: 'reject', issues: [{ code: 'missing_property', property: 'count' }] },
    },
  };
  vi.mocked(send.POST)
    .mockResolvedValueOnce(Response.json({ cache: 'first', validation }))
    .mockResolvedValueOnce(Response.json(rejection, { status: 400 }))
    .mockResolvedValueOnce(
      Response.json({ cache: 'last', validation: { mode: 'reject', issues: [] } }),
    );
  const response = await POST(
    new Request('http://localhost/api/batch', {
      method: 'POST',
      headers: { 'x-umami-cache': 'cached', 'content-length': '2' },
    }),
  );
  expect(await response.json()).toEqual({
    size: 3,
    processed: 2,
    errors: 1,
    details: [{ index: 1, response: rejection }],
    cache: 'first',
    validations: [{ index: 0, validation }],
  });
  for (const [request] of vi.mocked(send.POST).mock.calls) {
    expect(request.headers.get('x-umami-cache')).toBe('cached');
    expect(request.headers.get('content-type')).toBe('application/json');
    expect(request.headers.has('content-length')).toBe(false);
  }
});

test('unconfigured batches keep the original response shape', async () => {
  vi.mocked(parseRequest).mockResolvedValue({ body: [{}], error: undefined } as any);
  vi.mocked(send.POST).mockResolvedValue(Response.json({ cache: 'token' }));
  expect(
    await (await POST(new Request('http://localhost/api/batch', { method: 'POST' }))).json(),
  ).toEqual({
    size: 1,
    processed: 1,
    errors: 0,
    details: [],
    cache: 'token',
  });
});
