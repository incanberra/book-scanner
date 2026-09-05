import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractCoverDetails, cleanCoverText, runCoverReader } from '../src/cover';
import { requestCoverCamera, sourceCrop } from '../src/cover-camera';
import type { CoverLine } from '../src/cover-text';

const line = (text: string, y: number, height = 60, confidence = 90): CoverLine => ({ text, confidence, bbox: { x0: 10, x1: 500, y0: y, y1: y + height } });
const image = new Blob(['test'], { type: 'image/png' });
const reading = { text: 'Matilda\nRoald Dahl', title: 'Matilda', author: 'Roald Dahl', uncertain: true };
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

describe('cover identity suggestions', () => {
  it('finds an author above a large single-word title', () => {
    expect(extractCoverDetails('ROALD DAHL\nMATILDA', [line('ROALD DAHL', 20, 40), line('MATILDA', 200, 80)])).toMatchObject({ title: 'MATILDA', author: 'ROALD DAHL', uncertain: true });
  });
  it('joins a multiline title and excludes smaller subtitle and marketing text', () => {
    const lines = [line('THE LORD', 10), line('OF THE RINGS', 85), line('An epic journey', 170, 20), line('J. R. R. TOLKIEN', 400, 40), line('Bestselling author', 500, 20)];
    expect(extractCoverDetails(lines.map(l => l.text).join('\n'), lines)).toMatchObject({ title: 'THE LORD OF THE RINGS', author: 'J. R. R. TOLKIEN' });
  });
  it('recognises an explicit byline and retains raw text for correction', () => {
    const text = 'DUNE\nby Frank Herbert\nA NOVEL';
    expect(extractCoverDetails(text, [line('DUNE', 20), line('by Frank Herbert', 200), line('A NOVEL', 300)])).toEqual({ text, title: 'DUNE', author: 'Frank Herbert', uncertain: false });
  });
  it('leaves missing or uncertain authors editable rather than inventing them', () => {
    expect(extractCoverDetails('THE SILENT PATIENT')).toMatchObject({ title: 'THE SILENT PATIENT', author: '', uncertain: true });
    expect(extractCoverDetails('')).toMatchObject({ title: '', author: '' });
    expect(extractCoverDetails('X', [line('X', 20, 50, 10)])).toMatchObject({ title: '', author: '' });
  });
  it('ignores promotional phrases and quotation lines without deleting legitimate titles containing novel', () => {
    expect(cleanCoverText('Now a major motion picture\n“An amazing read”\nWinner of the prize\nA NOVEL')).toBe('');
    expect(cleanCoverText('A Novel Approach')).toBe('A Novel Approach');
  });
});

describe('OCR worker lifecycle', () => {
  function fixture() {
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: undefined as any, onerror: undefined as any };
    return { worker, factory: () => worker as unknown as Worker };
  }
  it('terminates during startup when cancelled, without waiting for the OCR library to initialise', async () => {
    const { worker, factory } = fixture(); const controller = new AbortController();
    const result = runCoverReader(image, controller.signal, vi.fn(), factory);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('times out a stalled worker and ignores a late result', async () => {
    vi.useFakeTimers(); const { worker, factory } = fixture();
    const result = runCoverReader(image, new AbortController().signal, vi.fn(), factory, 1000);
    const rejected = expect(result).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(1000); await rejected;
    worker.onmessage({ data: { kind: 'result', reading } });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('releases the worker on successful recognition', async () => {
    const { worker, factory } = fixture(); const progress = vi.fn();
    const result = runCoverReader(image, new AbortController().signal, progress, factory);
    worker.onmessage({ data: { kind: 'progress', text: 'Reading cover… 35%' } });
    worker.onmessage({ data: { kind: 'result', reading } });
    expect(await result).toEqual(reading); expect(progress).toHaveBeenCalledWith('Reading cover… 35%');
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
  it('surfaces startup/model errors immediately and releases the worker', async () => {
    const { worker, factory } = fixture();
    const result = runCoverReader(image, new AbortController().signal, vi.fn(), factory);
    worker.onmessage({ data: { kind: 'error', message: 'Model unavailable' } });
    await expect(result).rejects.toThrow('Model unavailable'); expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

describe('live camera lifecycle and guide mapping', () => {
  it('stops a late stream after the permission request was cancelled', async () => {
    const video = document.createElement('video'); document.body.append(video);
    const controller = new AbortController(); const stop = vi.fn();
    let resolve!: (stream: MediaStream) => void;
    const getMedia = vi.fn(() => new Promise<MediaStream>(r => { resolve = r; }));
    const result = requestCoverCamera(video, controller.signal, getMedia);
    controller.abort(); await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    resolve({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  });
  it('releases tracks when playback fails', async () => {
    const video = document.createElement('video'); document.body.append(video);
    video.play = vi.fn().mockRejectedValue(new Error('Playback failed')); const stop = vi.fn();
    await expect(requestCoverCamera(video, new AbortController().signal, vi.fn().mockResolvedValue({ getTracks: () => [{ stop }] }))).rejects.toThrow('Playback failed');
    expect(stop).toHaveBeenCalledOnce(); expect(video.srcObject).toBeNull();
  });
  it('maps a landscape guide with letterboxing without stretching the image', () => {
    expect(sourceCrop(1920, 1080, 400, 400, { x: 40, y: 40, width: 320, height: 320 })).toEqual({ x: 192, y: 0, width: 1536, height: 1080 });
  });
  it('maps portrait video and excludes guide margins', () => {
    expect(sourceCrop(900, 1200, 300, 400, { x: 30, y: 40, width: 240, height: 320 })).toEqual({ x: 90, y: 120, width: 720, height: 960 });
  });
});
