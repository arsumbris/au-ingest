// The shared emitter accepts scalars and lists of scalars. Converters author
// references deliberately and use literal() for external text.
function scalar(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') throw new Error('note fields must be strings, finite numbers, booleans, or lists of these');
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^[A-Za-z][A-Za-z0-9 ]*$/.test(value) && !/^(y|n|yes|no|true|false|on|off|null)$/i.test(value)) return value;
  return JSON.stringify(value);
}

/** Escape Arsumbris reference, contribution and anchor syntax in external text.
 * Escapes can be visible inside code blocks; the original bytes remain the authority. */
export const literal = (value) => String(value)
  .replace(/(?<!\\)\[\[/g, '\\[[')
  .replace(/\[:/g, '[\\:')
  .replace(/(^|\s)\^([A-Za-z0-9_-]+)(?=\s*$)/gm, '$1\\^$2');

export function sourceNote(type, fields, body) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*(?:::[A-Za-z0-9_.-]+)?$/.test(type)) throw new Error('invalid source type name');
  const lines = ['type: ' + type];
  for (const [field, value] of Object.entries(fields)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(field) || field === 'type') throw new Error('invalid note field: ' + field);
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (!value.length) lines.push(field + ': []');
      else lines.push(field + ':', ...value.map((item) => '  - ' + scalar(item)));
    } else lines.push(field + ': ' + scalar(value));
  }
  if (body !== undefined && typeof body !== 'string') throw new Error('note body must be a string');
  return '---\n' + lines.join('\n') + '\n---\n' + (body === undefined ? '' : '\n' + body + '\n');
}

export const day = (value) => String(value).slice(0, 10);
export const firstLine = (value) => String(value).split('\n').map((line) => line.trim())
  .find((line) => line && !/^(?:`{3,}|~{3,})/.test(line)) ?? '';
export const link = (target) => '[[' + target + ']]';
