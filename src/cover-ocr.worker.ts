import { createWorker, PSM, type Worker as OcrWorker } from 'tesseract.js';
import { extractCoverDetails, type CoverLine } from './cover-text';

// Own Tesseract's worker inside a dedicated parent worker so cancellation can
// terminate the whole worker tree even while createWorker is still initialising.
const host = self as unknown as { onmessage: ((event: MessageEvent<{ image: Blob; assets: string }>) => void) | null; postMessage: (data: unknown) => void };
host.onmessage = async ({ data: { image, assets } }) => {
  let reader: OcrWorker | undefined;
  let failed = false;
  const fail = () => {
    if (!failed) { failed = true; host.postMessage({ kind: 'error', message: 'The cover reader could not load or read this frame. Check your connection and retry, or enter the title and author.' }); }
  };
  try {
    reader = await createWorker('eng', 1, {
      workerPath: new URL('worker.min.js', assets).href,
      corePath: assets,
      langPath: assets,
      workerBlobURL: false,
      errorHandler: fail,
      logger: message => host.postMessage({ kind: 'progress', text: message.status === 'recognizing text'
        ? `Reading cover… ${Math.round(message.progress * 100)}%`
        : 'Starting cover reader… First use downloads the reader to this device.' })
    });
    if (failed) return;
    await reader.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const bitmap = await createImageBitmap(image, { imageOrientation: 'from-image' });
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close(); throw new Error('No canvas context'); }
    ctx.filter = 'grayscale(1) contrast(1.15)';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const prepared = await canvas.convertToBlob({ type: 'image/png' });
    const result = await reader.recognize(prepared, { rotateAuto: true }, { text: true, blocks: true });
    const lines: CoverLine[] = (result.data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines))
      .map(line => ({ text: line.text, confidence: line.confidence, bbox: line.bbox }));
    if (!failed) host.postMessage({ kind: 'result', reading: extractCoverDetails(result.data.text, lines) });
  } catch { fail(); }
  finally { await reader?.terminate(); }
};
