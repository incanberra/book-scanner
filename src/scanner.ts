import type { IScannerControls } from "@zxing/browser";
import { normaliseIsbn, ValidationError } from "./catalog";

export interface ScannerSession {
  readonly hasTorch: boolean;
  stop: () => void;
  setTorch: (enabled: boolean) => Promise<void>;
}

function stopVideoTracks(video: HTMLVideoElement): void {
  const stream = video.srcObject instanceof MediaStream ? video.srcObject : undefined;
  stream?.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
}

export async function startScanner(
  video: HTMLVideoElement,
  onCode: (isbn13: string) => void,
  onInvalid: (message: string) => void,
  onError: (message: string) => void
): Promise<ScannerSession> {
  const { BrowserMultiFormatReader } = await import("@zxing/browser");
  const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 200 });
  let controls: IScannerControls | undefined;
  let stopped = false;
  let completed = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    controls?.stop();
    stopVideoTracks(video);
  };

  try {
    controls = await reader.decodeFromConstraints(
      { audio: false, video: { facingMode: { ideal: "environment" } } },
      video,
      (result, error) => {
        if (stopped || completed) return;
        if (result) {
          try {
            const isbn13 = normaliseIsbn(result.getText());
            if (!isbn13) return;
            completed = true;
            stop();
            onCode(isbn13);
          } catch (scanError) {
            onInvalid(scanError instanceof Error ? scanError.message : "This is not a book barcode.");
          }
        } else if (error && !["NotFoundException", "ChecksumException", "FormatException"].includes(error.name)) {
          onError("The camera could not read this barcode. Try again or enter the ISBN manually.");
        }
      }
    );
    if (stopped) controls.stop();
  } catch (error) {
    stop();
    const name = error instanceof DOMException ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new ValidationError("Camera access was denied. You can still enter the ISBN manually.");
    }
    throw new ValidationError("The camera is unavailable. You can still enter the ISBN manually.");
  }

  return {
    get hasTorch() { return Boolean(controls?.switchTorch); },
    stop,
    setTorch: async (enabled) => {
      if (!controls?.switchTorch) throw new ValidationError("Torch control is not supported on this phone.");
      await controls.switchTorch(enabled);
    }
  };
}

export function validateScannedValue(value: string): string {
  const isbn = normaliseIsbn(value);
  if (!isbn) throw new ValidationError("No ISBN was detected.");
  return isbn;
}
