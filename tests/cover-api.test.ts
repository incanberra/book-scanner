// @vitest-environment node
/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { config } from '../netlify/functions/read-cover';

const token = 'test-only-access-token-12345678901234567890';
const origin = 'https://incanberra.github.io';
const jpeg = new Uint8Array([255,216,255,224,1]);
const request = (options: { token?: string; origin?: string; body?: Uint8Array; method?: string; type?: string } = {}) => new Request('https://example.netlify.app/.netlify/functions/read-cover', {
  method: options.method ?? 'POST',
  headers: { origin: options.origin ?? origin, authorization: `Bearer ${options.token ?? token}`, 'content-type': options.type ?? 'image/jpeg' },
  body: ['GET','OPTIONS'].includes(options.method ?? '') ? undefined : Buffer.from(options.body ?? jpeg)
});
beforeEach(() => {
  vi.stubEnv('OPENROUTER_API_KEY', 'test-provider-key'); vi.stubEnv('COVER_ACCESS_TOKEN', token); vi.stubEnv('COVER_ALLOWED_ORIGIN', origin);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: '{"title":"Matilda","author":"Roald Dahl","isbn":"discard"}' } }] })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('secure cover API', () => {
  it('uses the fixed model, returns only book identity and never leaks secrets', async () => {
    const response = await handler(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ title: 'Matilda', author: 'Roald Dahl', text: 'Matilda\nRoald Dahl', uncertain: true });
    const call = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(call[1]!.body as string);
    expect(body.model).toBe('qwen/qwen3.7-flash');
    expect(body.messages[1].content[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    [{ token: 'wrong' },401], [{ origin: 'https://evil.example' },403],
    [{ type: 'application/json' },415], [{ body: new Uint8Array([1,2,3]) },400],
    [{ body: new Uint8Array(3 * 1024 * 1024 + 1) },413], [{ method: 'GET' },405]
  ])('rejects invalid requests before spending credits', async (options, status) => {
    expect((await handler(request(options))).status).toBe(status); expect(fetch).not.toHaveBeenCalled();
  });
  it('handles preflight without authentication or provider calls', async () => {
    const response = await handler(request({ method: 'OPTIONS', token: '' }));
    expect(response.status).toBe(204); expect(response.headers.get('access-control-allow-origin')).toBe(origin); expect(fetch).not.toHaveBeenCalled();
  });
  it('fails closed without configuration', async () => {
    vi.stubEnv('COVER_ACCESS_TOKEN', ''); expect((await handler(request())).status).toBe(503); expect(fetch).not.toHaveBeenCalled();
  });
  it('sanitizes upstream failures', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('secret upstream detail', { status: 402 }));
    const response = await handler(request()); expect(response.status).toBe(502); expect(await response.text()).not.toContain('secret');
  });
  it.each(['not JSON', '{"title":5,"author":"x"}', 'null'])('rejects malformed model output', async content => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ choices: [{ message: { content } }] }));
    expect((await handler(request())).status).toBe(502);
  });
  it('accepts unreadable fields without guessing and has platform rate limits', async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ choices: [{ message: { content: '{"title":"","author":""}' } }] }));
    expect((await (await handler(request())).json()).title).toBe(''); expect(config.rateLimit.windowLimit).toBe(20);
  });
});
