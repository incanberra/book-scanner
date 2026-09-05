export interface CoverCamera { stop(): void }
export function cameraError(error: unknown): string {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera permission was denied. Allow camera access in your browser, choose an image, or enter the title and author.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No suitable camera was found. Choose an image or enter the title and author.';
  if (name === 'NotReadableError') return 'The camera is busy. Close other camera apps and retry, or choose an image.';
  return error instanceof Error ? error.message : 'The camera could not start. Choose an image or enter the title and author.';
}

export async function requestCoverCamera(video: HTMLVideoElement, signal: AbortSignal,
  getMedia = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)): Promise<CoverCamera> {
  if (!getMedia) throw new Error('Live camera scanning is unavailable in this browser. Choose an image or enter the title and author.');
  signal.throwIfAborted();
  let stream: MediaStream | undefined;
  let rejectAbort: (error: Error) => void = () => undefined;
  const stop = () => {
    stream?.getTracks().forEach(track => track.stop());
    if (video.srcObject === stream) video.srcObject = null;
    signal.removeEventListener('abort', abort);
  };
  const abort = () => { stop(); rejectAbort(new DOMException('Camera cancelled', 'AbortError')); };
  const interrupted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  signal.addEventListener('abort', abort, { once: true });
  try {
    const request = getMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then(value => {
        if (signal.aborted || !video.isConnected) { value.getTracks().forEach(track => track.stop()); throw new DOMException('Camera cancelled', 'AbortError'); }
        stream = value;
        video.srcObject = value;
      });
    await Promise.race([request, interrupted]);
    await Promise.race([video.play(), interrupted]);
    signal.throwIfAborted();
    if (!video.isConnected) throw new DOMException('Camera cancelled', 'AbortError');
    return { stop };
  } catch (error) { stop(); throw error; }
}

/** Map a guide in object-fit:contain display coordinates back to video pixels. */
export function sourceCrop(width: number, height: number, displayWidth: number, displayHeight: number,
  guide: { x: number; y: number; width: number; height: number }) {
  const scale = Math.min(displayWidth / width, displayHeight / height);
  const left = (displayWidth - width * scale) / 2;
  const top = (displayHeight - height * scale) / 2;
  const x = Math.max(0, (guide.x - left) / scale);
  const y = Math.max(0, (guide.y - top) / scale);
  const right = Math.min(width, (guide.x + guide.width - left) / scale);
  const bottom = Math.min(height, (guide.y + guide.height - top) / scale);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

export function captureCoverFrame(video: HTMLVideoElement, guide: HTMLElement): Promise<Blob> {
  if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return Promise.reject(new Error('The camera is not ready yet. Wait a moment and retry.'));
  const box = video.getBoundingClientRect();
  const frame = guide.getBoundingClientRect();
  const crop = sourceCrop(video.videoWidth, video.videoHeight, box.width, box.height,
    { x: frame.left - box.left, y: frame.top - box.top, width: frame.width, height: frame.height });
  const scale = Math.min(1, 2000 / Math.max(crop.width, crop.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.width * scale));
  canvas.height = Math.max(1, Math.round(crop.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('This browser cannot read camera frames. Choose an image or enter the title and author.'));
  ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not read this frame. Please try again.')), 'image/png'));
}
