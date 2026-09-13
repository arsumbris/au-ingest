---
type: au.engine.readme::au-engine
tldr: Convert files into Markdown source notes. Keep the originals and add converters for other formats.
---

# Repo Overview

> Work in progress and not thoroughly tested.
> Expect breaking changes.

## What this is

`au-ingest` converts files into Markdown source notes in your Arsumbris repo.
Each note links to its original file and records when you captured it.
The original stays unchanged.

| Converter | Files |
| --- | --- |
| `document` | Office, OpenDocument, RTF, EPUB and CSV |
| `pdf` | PDFs with extractable text |

Scanned PDFs need OCR before import.

## How to use this

**Install**

Use Node 24 or newer.
From the `au-ingest` package directory, install the converter dependencies:

```sh
npm install --prefix converters
```

In your project:

1. Add `au-ingest` to `deps` in `.arsumbris/repo.yaml`
2. Add `au-ingest` to `discover` in `.arsumbris/workspace.yaml`
3. Reopen the workspace and select the `ingest` tool for your agent

**Import**

Save and commit the original file in your repo.
Ask your agent to import it with `ingest`:

```json
{
  "raw": "content/report.docx",
  "date": "2026-09-09",
  "converter": "document"
}
```

Use the date you captured the file.
This creates `content/report.md` beside the original.
Check the note against the original.

To replace an existing note, use `refresh: true`.
This replaces its full content.
See the `type/mcp.tool.ingest.type.yaml` for options and limits.

## How to extend this

Add a source type and converter in your own package.
Use the document converter in `converters/document.convert.mjs` as an example.
