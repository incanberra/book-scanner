import type { CoverReading } from './cover-text';
import { aiEndpoint, readCoverAi } from './cover-ai';
export { cleanCoverText, extractCoverDetails } from './cover-text';
export type { CoverReading } from './cover-text';

export function runCoverReader(image: Blob, signal: AbortSignal, progress: (text: string) => void,
  makeWorker = () => new Worker(new URL('./cover-ocr.worker.ts', import.meta.url), { type: 'module' }),
  timeoutMs = 60_000): Promise<CoverReading> {
  if (signal.aborted) return Promise.reject(new DOMException('Cover scan cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try { worker = makeWorker(); } catch { reject(new Error('This browser could not start the cover reader. Enter the title and author instead.')); return; }
    let finished = false;
    const finish = (error?: Error, reading?: CoverReading) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error); else resolve(reading!);
    };
    const abort = () => finish(new DOMException('Cover scan cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('Cover reading timed out. Try a clearer view or enter the title and author.')), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => finish(new Error('The cover reader could not start. Check your connection and try again, or enter the title and author.'));
    worker.onmessageerror = () => finish(new Error('The cover reader could not return its result. Please try again.'));
    worker.onmessage = ({ data }) => {
      if (finished) return;
      if (data.kind === 'progress') progress(data.text);
      if (data.kind === 'error') finish(new Error(data.message));
      if (data.kind === 'result') finish(undefined, data.reading);
    };
    try { worker.postMessage({ image, assets: new URL(`${import.meta.env.BASE_URL}ocr/v1/`, location.origin).href }); }
    catch { finish(new Error('Could not send this frame to the cover reader. Please try again.')); }
  });
}

export async function readCover(file: Blob, signal: AbortSignal, progress: (text: string) => void): Promise<CoverReading> {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo of the front cover.');
  if (file.size > 20 * 1024 * 1024) throw new Error('This photo is too large. Choose a photo under 20 MB.');
  signal.throwIfAborted();
  if (aiEndpoint()) return readCoverAi(file, signal, progress);
  return runCoverReader(file, signal, progress);
}
