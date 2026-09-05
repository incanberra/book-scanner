export interface CoverLine {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}
export interface CoverReading {
  text: string;
  title: string;
  author: string;
  uncertain: boolean;
}

const promotional = /best\s*selling|bestseller|\bauthor of\b|\bnow (?:a|on)\b|\bmajor motion\b|\bwinner of\b|\b(?:prize|award)[ -]winning\b|\b(?:new york|sunday) times\b|\b\d+ million\b|\b(?:penguin|vintage|penguin modern) classics\b/i;
export function usefulCoverLine(text: string): boolean {
  return /\p{L}/u.test(text) && !promotional.test(text)
    && !/^\s*(?:a novel|a memoir|an autobiography|a thriller|fiction|paperback|penguin books|puffin books)\s*[.!]?\s*$/i.test(text)
    && !/[“”"]/.test(text);
}
export function cleanCoverText(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).filter(usefulCoverLine)
    .join(' ').replace(/[^\p{L}\p{N}\s'’-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
}
function nameLike(text: string): boolean {
  const words = text.replace(/^by\s+/i, '').trim().split(/\s+/);
  return words.length >= 2 && words.length <= 5 && !/\b(the|of|and|in|on|for|a|an|to|with|from|at)\b/i.test(text)
    && words.every(word => /^[\p{L}][\p{L}.'’-]*$/u.test(word));
}

/** Layout-based suggestions, never authoritative bibliographic facts. */
export function extractCoverDetails(text: string, input: CoverLine[] = []): CoverReading {
  const raw = text.trim().slice(0, 2000);
  const fallback = text.split(/\r?\n/).map((text, i) => ({ text, confidence: 0, bbox: { x0: 0, x1: 1, y0: i * 20, y1: i * 20 + 10 } }));
  const lines = (input.length ? input : fallback).filter(line => usefulCoverLine(line.text.trim()))
    .filter(line => !input.length || line.confidence >= 35)
    .map(line => ({ ...line, text: line.text.trim(), height: Math.max(1, line.bbox.y1 - line.bbox.y0) }))
    .sort((a,b) => a.bbox.y0 - b.bbox.y0);
  if (!lines.length) return { text: raw, title: '', author: '', uncertain: true };
  const explicit = lines.find(line => /^by\s+\p{L}/iu.test(line.text));
  const possibleAuthors = lines.filter(line => line === explicit || nameLike(line.text));
  const authorLine = explicit ?? (lines.length > 1 ? possibleAuthors.find(line => line === lines.at(-1)) ?? possibleAuthors.find(line => line === lines[0]) : undefined);
  const titleLines = lines.filter(line => line !== authorLine);
  const prominent = titleLines.reduce<(typeof lines)[number] | undefined>((best, line) => !best || line.height > best.height ? line : best, undefined);
  const titleGroup = prominent ? titleLines.filter(line => line === prominent || (
    line.height >= prominent.height * 0.65 && Math.abs(line.bbox.y0 - prominent.bbox.y0) < prominent.height * 3.5
  )) : [];
  const title = titleGroup.map(line => line.text).join(' ').slice(0, 200);
  const author = (authorLine?.text.replace(/^by\s+/i, '') ?? '').slice(0, 150);
  return { text: raw, title, author, uncertain: !explicit || !title || !author || lines.some(line => line.confidence < 60) };
}
