import type { Worker } from "tesseract.js";
import workerUrl from "tesseract.js/dist/worker.min.js?url";

/** Remove obvious cover blurbs; keep the remaining words editable by the reader. */
export function cleanCoverText(text: string): string {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\p{L}/u.test(line))
    .filter((line) => !/best\s*selling|bestseller|\bauthor of\b|\ba novel\b|\bnow a\b|\bprize\b|\baward\b/i.test(line))
    .join(" ").replace(/[^\p{L}\p{N}\s'’-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** Recognition happens locally. Only the resulting search words leave the device. */
export async function readCover(file: File, signal: AbortSignal, progress: (text: string) => void): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose a photo of the front cover.");
  if (file.size > 20 * 1024 * 1024) throw new Error("This photo is too large. Choose a photo under 20 MB.");
  let worker: Worker | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectStopped: (reason: Error) => void = () => undefined;
  const stop = (reason: Error) => {
    stopped = true;
    void worker?.terminate();
    rejectStopped(reason);
  };
  const abort = () => stop(new DOMException("Cover scan cancelled", "AbortError"));
  const interrupted = new Promise<never>((_, reject) => { rejectStopped = reject; });
  signal.addEventListener("abort", abort, { once: true });
  const recognise = async () => {
    signal.throwIfAborted();
    const { createWorker, PSM } = await import("tesseract.js");
    if (stopped) return "";
    worker = await createWorker("eng", 1, {
      workerPath: new URL(workerUrl, location.href).href,
      logger: (message) => {
        if (!stopped) progress(message.status === "recognizing text"
          ? `Reading cover… ${Math.round(message.progress * 100)}%`
          : "Preparing cover reader… First use may take a moment.");
      },
      errorHandler: () => { /* Errors also reject the pending worker operation. */ }
    });
    if (stopped) { await worker.terminate(); return ""; }
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    // Bound the image sent to the OCR worker to reduce memory use on phones.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) { bitmap.close(); throw new Error("This browser cannot read cover photos. Enter the title and author below."); }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    if (stopped) return "";
    const result = await worker.recognize(canvas);
    return cleanCoverText(result.data.text);
  };
  try {
    timer = setTimeout(() => stop(new Error("Cover reading timed out. Try a clearer photo or enter the title and author below.")), 60_000);
    return await Promise.race([recognise(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    await worker?.terminate();
  }
}
