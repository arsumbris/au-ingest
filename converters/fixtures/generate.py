#!/usr/bin/env python3
"""Generate original conversion samples using only Python's standard library.

Run: python3 converters/fixtures/generate.py
No external documents, images, templates, or font programs are used.
"""

from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZIP_STORED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent
TITLE = "Conversion test document"
BODY = "This original sample checks document conversion."
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def write(name, data):
    path = ROOT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data.encode("utf-8") if isinstance(data, str) else data)


def archive(name, entries):
    path = ROOT / "document" / name
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, "w", compression=ZIP_STORED) as z:
        for name, content in entries.items():
            info = ZipInfo(name, date_time=(2000, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            z.writestr(info, content)


def relationships(items):
    return '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
        f'<Relationship Id="{id}" Type="{R}/{kind}" Target="{target}"'
        + (' TargetMode="External"' if target.startswith("https:") else "") + '/>'
        for id, kind, target in items
    ) + '</Relationships>'


def office(main, parts):
    return {
        "[Content_Types].xml": '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>' + "".join(
            f'<Override PartName="/{path}" ContentType="application/vnd.openxmlformats-officedocument.{kind}+xml"/>'
            for path, kind in parts
        ) + '</Types>',
        "_rels/.rels": relationships([("rId1", "officeDocument", main)]),
    }


def paragraph(text, properties=""):
    return f'<w:p>{properties}<w:r><w:t>{escape(text)}</w:t></w:r></w:p>'


docx = office("word/document.xml", [
    ("word/document.xml", "wordprocessingml.document.main"),
    ("word/styles.xml", "wordprocessingml.styles"),
    ("word/numbering.xml", "wordprocessingml.numbering"),
    ("word/footnotes.xml", "wordprocessingml.footnotes"),
])
docx.update({
    "word/document.xml": f'<w:document xmlns:w="{W}" xmlns:r="{R}"><w:body>'
    + paragraph(TITLE, '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>')
    + paragraph(BODY)
    + '<w:p><w:hyperlink r:id="rId4"><w:r><w:t>Example link</w:t></w:r></w:hyperlink>'
    '<w:r><w:footnoteReference w:id="1"/></w:r></w:p>'
    + paragraph("Check the output.", '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>')
    + '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>'
    + ''.join('<w:tr>' + ''.join('<w:tc>' + paragraph(cell) + '</w:tc>' for cell in row) + '</w:tr>'
              for row in [("Item", "Count"), ("Square", "7")])
    + '</w:tbl><w:sectPr/></w:body></w:document>',
    "word/styles.xml": f'<w:styles xmlns:w="{W}"><w:style w:type="paragraph" w:styleId="Heading1">'
    '<w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>',
    "word/numbering.xml": f'<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>'
    '</w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
    "word/footnotes.xml": f'<w:footnotes xmlns:w="{W}"><w:footnote w:id="-1" w:type="separator">'
    '<w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="0" w:type="continuationSeparator">'
    '<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>'
    '<w:footnote w:id="1">' + paragraph("Original test footnote.") + '</w:footnote></w:footnotes>',
    "word/_rels/document.xml.rels": relationships([
        ("rId1", "styles", "styles.xml"), ("rId2", "numbering", "numbering.xml"),
        ("rId3", "footnotes", "footnotes.xml"), ("rId4", "hyperlink", "https://example.com/test"),
    ]),
})
archive("report.docx", docx)


def sheet(rows):
    return f'<worksheet xmlns="{S}"><sheetData>' + ''.join(
        f'<row r="{i}">' + ''.join(
            f'<c r="{chr(65 + j)}{i}"><v>{value}</v></c>' if isinstance(value, int) else
            f'<c r="{chr(65 + j)}{i}" t="inlineStr"><is><t>{escape(value)}</t></is></c>'
            for j, value in enumerate(row)
        ) + '</row>' for i, row in enumerate(rows, 1)
    ) + '</sheetData></worksheet>'


xlsx = office("xl/workbook.xml", [
    ("xl/workbook.xml", "spreadsheetml.sheet.main"),
    ("xl/worksheets/sheet1.xml", "spreadsheetml.worksheet"),
    ("xl/worksheets/sheet2.xml", "spreadsheetml.worksheet"),
])
xlsx.update({
    "xl/workbook.xml": f'<workbook xmlns="{S}" xmlns:r="{R}"><sheets>'
    '<sheet name="Summary" sheetId="1" r:id="rId1"/>'
    '<sheet name="Details" sheetId="2" r:id="rId2"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": relationships([
        ("rId1", "worksheet", "worksheets/sheet1.xml"), ("rId2", "worksheet", "worksheets/sheet2.xml"),
    ]),
    "xl/worksheets/sheet1.xml": sheet([("Item", "Count"), ("Square", 7)]),
    "xl/worksheets/sheet2.xml": sheet([("Item", "Planned", "Actual", "Hours"), ("Circle", 8, 6, 2)]),
})
archive("budget.xlsx", xlsx)


def shape(text):
    return ('<p:sp><p:nvSpPr><p:cNvPr id="2" name="Text"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>'
    '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="8000000" cy="2000000"/></a:xfrm>'
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' + (
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' + escape(text)
        + '</a:t></a:r></a:p></p:txBody></p:sp>'
    ))


def slide(text, tag):
    return (f'<p:{tag} xmlns:p="{P}" xmlns:a="{A}" xmlns:r="{R}"><p:cSld><p:spTree>'
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    '<p:grpSpPr/>' + shape(text) + f'</p:spTree></p:cSld></p:{tag}>')


pptx = office("ppt/presentation.xml", [
    ("ppt/presentation.xml", "presentationml.presentation.main"),
    ("ppt/slides/slide1.xml", "presentationml.slide"),
    ("ppt/notesSlides/notesSlide1.xml", "presentationml.notesSlide"),
])
pptx.update({
    "ppt/presentation.xml": f'<p:presentation xmlns:p="{P}" xmlns:r="{R}">'
    '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>'
    '<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>',
    "ppt/_rels/presentation.xml.rels": relationships([("rId1", "slide", "slides/slide1.xml")]),
    "ppt/slides/slide1.xml": slide(TITLE, "sld"),
    "ppt/slides/_rels/slide1.xml.rels": relationships([("rId1", "notesSlide", "../notesSlides/notesSlide1.xml")]),
    "ppt/notesSlides/notesSlide1.xml": slide("Original test speaker notes.", "notes"),
    "ppt/notesSlides/_rels/notesSlide1.xml.rels": relationships([("rId1", "slide", "../slides/slide1.xml")]),
})
archive("deck.pptx", pptx)

archive("sample.odt", {
    "mimetype": "application/vnd.oasis.opendocument.text",
    "META-INF/manifest.xml": '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2">'
    '<manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/>'
    '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>',
    "content.xml": '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:text>'
    f'<text:h text:outline-level="1">{TITLE}</text:h><text:p>{BODY}</text:p>'
    '</office:text></office:body></office:document-content>',
})

archive("sample.epub", {
    "mimetype": "application/epub+zip",
    "META-INF/container.xml": '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">'
    '<rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    "content.opf": '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">'
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">'
    f'<dc:identifier id="id">urn:au-ingest:conversion-test</dc:identifier><dc:title>{TITLE}</dc:title>'
    '<dc:language>en</dc:language><meta property="dcterms:modified">2000-01-01T00:00:00Z</meta></metadata>'
    '<manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>'
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest>'
    '<spine><itemref idref="chapter"/></spine></package>',
    "chapter.xhtml": f'<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{TITLE}</title></head>'
    f'<body><h1>{TITLE}</h1><p>{BODY}</p><p>Check <code>inline code</code>.</p></body></html>',
    "nav.xhtml": '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
    '<head><title>Contents</title></head><body><nav epub:type="toc"><ol>'
    '<li><a href="chapter.xhtml">Test document</a></li></ol></nav></body></html>',
})

write("document/sample.rtf", r"{\rtf1\ansi {\b " + TITLE + r"}\par " + BODY + r"\par}" + "\n")
write("document/sample.csv", 'item,count,note\nsquare,3,sample\n"quoted, with comma",7,edge-case\n')


def pdf(name, pages):
    objects = [b"", b""]

    def add(data):
        objects.append(data.encode("ascii") if isinstance(data, str) else data)
        return len(objects)

    def stream(data, attributes=""):
        return add(f'<< /Length {len(data)} {attributes} >>\nstream\n'.encode("ascii") + data + b'\nendstream')

    page_ids = []
    for kind in pages:
        if kind == "text":
            # Standard PDF font reference only: no font program is embedded.
            font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
            content = stream(f'BT /F1 18 Tf 72 720 Td ({TITLE}) Tj 0 -30 Td /F1 12 Tf ({BODY}) Tj ET'.encode("ascii"))
            resources = f'<< /Font << /F1 {font} 0 R >> >>'
        else:
            # Original 16x16 checkerboard pixels: no rendered text or font use.
            pixels = bytes(0 if (x // 4 + y // 4) % 2 else 255 for y in range(16) for x in range(16))
            img = stream(pixels, '/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8')
            content = stream(b'q 468 0 0 648 72 72 cm /Im1 Do Q')
            resources = f'<< /XObject << /Im1 {img} 0 R >> >>'
        page_ids.append(add(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources {resources} /Contents {content} 0 R >>'))
    objects[0] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objects[1] = f'<< /Type /Pages /Count {len(pages)} /Kids [{" ".join(f"{i} 0 R" for i in page_ids)}] >>'.encode("ascii")
    data = bytearray(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
    offsets = []
    for i, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{i} 0 obj\n'.encode("ascii") + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(f'xref\n0 {len(objects) + 1}\n0000000000 65535 f\r\n'.encode("ascii"))
    for offset in offsets:
        data.extend(f'{offset:010d} 00000 n\r\n'.encode("ascii"))
    data.extend(f'trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode("ascii"))
    write("pdf/" + name, data)


pdf("sample-text.pdf", ["text"])
pdf("sample-scanned.pdf", ["image"])
pdf("sample-mixed.pdf", ["text", "image"])
