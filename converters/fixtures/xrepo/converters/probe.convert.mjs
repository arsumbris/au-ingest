// A fixture converter for testing discovery and the injected note helpers.
export function convert({ raw, date, self, note }) {
  const { sourceNote, link } = note;
  const d = JSON.parse(raw.toString());
  const src = sourceNote('probe::xrepo-fixture', {
    id: d.id,
    captured: date,
    count: d.count ?? 0,
    tldr: note.literal(note.firstLine(d.text ?? '') || d.id),
    original: link(self.raw),
  }, note.literal(d.text ?? ''));
  return { source: src };
}
