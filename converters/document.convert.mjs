// AnyDoc renders document formats; PDFs use their own source type.
import { extname } from 'node:path';
import { toMarkdownBytes, formatFromExtension, formatFromBytes } from '@firecrawl/anydoc';

export async function convert({ raw, date, self, note }) {
  const { sourceNote, firstLine, link, literal } = note;

  // CSV has no signature, so prefer the extension before inspecting bytes.
  const format = formatFromExtension(extname(self.raw)) ?? formatFromBytes(raw);
  if (!format) throw new Error(`document.convert: unknown document format for '${self.raw}' — anydoc names it by neither extension nor content`);
  if (format === 'pdf') throw new Error("document.convert: a PDF routes to the 'pdf' converter");

  let body;
  try {
    body = (await toMarkdownBytes(raw, format)).trim();
  } catch (e) {
    throw new Error(`document.convert: anydoc could not convert this ${format} (${e.code ?? 'error'}): ${e.message}. The raw is preserved as the backstop.`);
  }
  if (!body) throw new Error(`document.convert: ${format} produced no extractable content`);

  return { source: sourceNote('document::au-ingest', {
    format,
    captured: date,
    tldr: literal(firstLine(body).replace(/^#+\s+/, '')) || undefined,
    original: link(self.raw),
  }, literal(body)) };
}
