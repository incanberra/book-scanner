import type { Page } from '@playwright/test';

/** Deterministic camera frames, with real MediaStream tracks and HTMLVideoElement. */
export async function fakeCamera(page: Page, layout: 'portrait' | 'landscape' | 'tilted' = 'portrait'): Promise<void> {
  await page.addInitScript((layout) => {
    const runtime = window as any;
    runtime.cameraState = { requests: [], tracks: [], mode: 'ready', pending: [] };
    const makeStream = () => {
      const canvas = document.createElement('canvas'); canvas.width = layout === 'landscape' ? 1200 : 900; canvas.height = layout === 'landscape' ? 900 : 1200;
      const ctx = canvas.getContext('2d')!;
      const draw = () => {
        ctx.resetTransform(); ctx.fillStyle = '#faf4e3'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (layout === 'tilted') { ctx.translate(25, 0); ctx.rotate(0.035); }
        ctx.fillStyle = '#18392b'; ctx.font = 'bold 115px Arial'; ctx.fillText('MATILDA', 90, 290);
        ctx.font = 'bold 85px Arial'; ctx.fillText('ROALD DAHL', 90, layout === 'landscape' ? 720 : 950);
      };
      draw(); const stream = canvas.captureStream(5); const timer = setInterval(draw, 200);
      stream.getTracks().forEach(track => {
        runtime.cameraState.tracks.push(track);
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      });
      return stream;
    };
    const getUserMedia = async (constraints: MediaStreamConstraints) => {
      runtime.cameraState.requests.push(constraints);
      if (runtime.cameraState.mode === 'denied') throw new DOMException('Permission denied', 'NotAllowedError');
      if (runtime.cameraState.mode === 'pending') return new Promise(resolve => runtime.cameraState.pending.push(() => resolve(makeStream())));
      return makeStream();
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: getUserMedia });
  }, layout);
}

/** Mock just the OCR worker boundary; camera, extraction display and search stay real. */
export async function fakeOcr(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const runtime = window as any;
    runtime.ocrState = { workers: [], delay: 25, fail: false, empty: false, imageBytes: 0 };
    const Native = window.Worker;
    window.Worker = function (url: string | URL, options?: WorkerOptions) {
      if (!String(url).includes('cover-ocr.worker')) return new Native(url, options);
      const worker: any = { onmessage: null, onerror: null, terminated: false,
        postMessage(data: {image: Blob}) {
          runtime.ocrState.imageBytes = data.image.size;
          setTimeout(() => { if (!worker.terminated) worker.onmessage?.({ data: { kind: 'progress', text: 'Reading cover… 35%' } }); }, 0);
          setTimeout(() => {
            if (worker.terminated) return;
            worker.onmessage?.({ data: runtime.ocrState.fail ? { kind: 'error', message: 'The cover reader could not load or read this frame.' } : {
              kind: 'result', reading: runtime.ocrState.empty ? { text: '', title: '', author: '', uncertain: true } : { text: 'MATILDA\nROALD DAHL', title: 'MATILDA', author: 'ROALD DAHL', uncertain: true }
            } });
          }, runtime.ocrState.delay);
        }, terminate() { worker.terminated = true; } };
      runtime.ocrState.workers.push(worker); return worker;
    } as unknown as typeof Worker;
  });
}

export async function mockBookSearch(page: Page) {
  await page.route('**/search.json?**', route => route.fulfill({ json: {
    docs: new URL(route.request().url()).searchParams.has('isbn') ? [] : [
      { key: '/works/OL1W', title: 'Matilda', author_name: ['Roald Dahl'], isbn: ['9780061120084'], publisher: ['Wrong edition'] }
    ]
  } }));
}

export async function openCoverFallback(page: Page, checker = false) {
  if (checker) await page.getByRole('button', { name: 'Book Check', exact: true }).click();
  await page.getByLabel(checker ? 'Book Check ISBN-10 or ISBN-13' : 'ISBN-10 or ISBN-13', { exact: true }).fill('9780140328721');
  await page.getByRole('button', { name: checker ? 'Check book' : 'Find book', exact: true }).click();
  await page.getByRole('button', { name: 'Scan front cover', exact: true }).click();
}
export const tracksEnded = (page: Page) => page.evaluate(() => (window as any).cameraState.tracks.every((track: MediaStreamTrack) => track.readyState === 'ended'));
