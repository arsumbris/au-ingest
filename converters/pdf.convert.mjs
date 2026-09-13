import { toMarkdownBytes } from '@firecrawl/anydoc';

export async function convert({ raw, date, self, note }) {
  const { sourceNote, firstLine, link, literal } = note;
  // AnyDoc rejects PDFs with pages requiring OCR.
  const body = (await toMarkdownBytes(raw, 'pdf')).trim();
  if (!body) throw new Error('pdf.convert: no extractable text');

  return { source: sourceNote('pdf::au-ingest', {
    captured: date,
    tldr: literal(firstLine(body).replace(/^#+\s+/, '')),
    original: link(self.raw),
  }, literal(body)) };
}
