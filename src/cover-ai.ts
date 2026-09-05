import type { CoverReading } from './cover-text';

let accessToken = ''; // Memory only: never catalogue backups, URLs or localStorage.
export function aiEndpoint(): string { return localStorage.getItem('cover-ai-endpoint') ?? ''; }
export function configureCoverAi(endpoint: string, token: string): void {
  if (!endpoint.trim()) { localStorage.removeItem('cover-ai-endpoint'); accessToken = ''; return; }
  const url = new URL(endpoint.trim());
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.netlify.app') || url.username || url.password || url.search || url.hash || url.pathname !== '/.netlify/functions/read-cover') {
    throw new Error('Use https://YOUR-SITE.netlify.app/.netlify/functions/read-cover');
  }
  if (token.trim().length < 32 || token.trim().length > 256) throw new Error('Enter your scanner access token (32–256 characters), not your OpenRouter key.');
  if (token.trim().startsWith('sk-or-')) throw new Error('Use the separate scanner access token, not your OpenRouter key.');
  localStorage.setItem('cover-ai-endpoint', url.href);
  accessToken = token.trim();
}

export async function readCoverAi(image: Blob, signal: AbortSignal, progress: (s: string) => void): Promise<CoverReading> {
  if (!accessToken) throw new Error('Unlock AI scanning in Settings with your scanner access token, or disable AI to use local OCR.');
  signal.throwIfAborted();
  progress('Preparing cover for AI…');
  const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
  let frame: Blob;
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Cannot prepare image.');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    frame = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('Cannot prepare image.')), 'image/jpeg', 0.9));
  } finally { bitmap.close(); }
  signal.throwIfAborted();
  if (frame.size > 3 * 1024 * 1024) throw new Error('Cover is too large. Try again.');
  progress('Reading cover with Qwen via OpenRouter…');
  let response: Response;
  try {
    response = await fetch(aiEndpoint(), { method: 'POST', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'image/jpeg' }, body: frame });
  } catch {
    signal.throwIfAborted();
    throw new Error('Cannot reach AI scanner. Check your connection and Netlify configuration, or use local OCR.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(response.status === 429 ? 'Too many scans. Wait a minute and retry.' : typeof data.error === 'string' ? data.error : 'AI scanner is unavailable.');
  if (typeof data.title !== 'string' || typeof data.author !== 'string' || data.title.length > 500 || data.author.length > 500) throw new Error('AI returned invalid book details.');
  return { title: data.title, author: data.author, text: [data.title, data.author].filter(Boolean).join('\n'), uncertain: true };
}
