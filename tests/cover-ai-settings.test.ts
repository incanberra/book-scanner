import { afterEach, expect, it } from 'vitest';
import { aiEndpoint, configureCoverAi, readCoverAi, DEFAULT_AI_ENDPOINT } from '../src/cover-ai';
const endpoint = DEFAULT_AI_ENDPOINT;
const token = 'test-only-access-token-12345678901234567890';
afterEach(() => configureCoverAi('', ''));
it('persists only the endpoint and can disable AI', () => {
  configureCoverAi(endpoint, token); expect(aiEndpoint()).toBe(endpoint);
  expect(JSON.stringify(localStorage)).toContain(token);
  configureCoverAi('', ''); expect(aiEndpoint()).toBe('');
});
it.each(['http://example.netlify.app/.netlify/functions/read-cover','https://evil.example/.netlify/functions/read-cover',endpoint + '?token=secret',endpoint + '#token'])('rejects unsafe endpoints', url => {
  expect(() => configureCoverAi(url, token)).toThrow();
});
it('rejects provider keys and short access tokens', () => {
  expect(() => configureCoverAi(endpoint, 'short')).toThrow();
  expect(() => configureCoverAi(endpoint, 'sk-or-' + token)).toThrow();
});
it('requires unlocking without sending any image', async () => {
  configureCoverAi('', '');
  await expect(readCoverAi(new Blob(), new AbortController().signal, () => {})).rejects.toThrow('Enable AI');
});
