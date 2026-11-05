import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import { mergePdfs } from '../src/ui/pdf'
import { addBookmarks, applyPageSize, countFigmaLinks, dedupeImages } from '../src/ui/pdfFinish'

// 1×1 red PNG
const PNG = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
  ),
  (c) => c.charCodeAt(0)
)

/** A one-page "frame" PDF that draws the same picture, like each Figma frame export does */
async function frameWithPicture(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([1920, 1248])
  const image = await doc.embedPng(PNG)
  page.drawImage(image, { x: 10, y: 10, width: 100, height: 100 })
  return await doc.save()
}

function imageCount(doc: PDFDocument): number {
  return doc.context
    .enumerateIndirectObjects()
    .filter(([, object]) => /\/Subtype \/Image/.test(object.toString().slice(0, 300))).length
}

describe('dedupeImages', () => {
  it('stores a picture repeated on every page once, and every page still draws it', async () => {
    const merged = await mergePdfs(
      [
        { index: 0, bytes: await frameWithPicture() },
        { index: 1, bytes: await frameWithPicture() },
        { index: 2, bytes: await frameWithPicture() }
      ],
      { title: 't', createdAt: new Date(0) }
    )
    expect(merged.imagesShared).toBeGreaterThanOrEqual(2)
    const doc = await PDFDocument.load(merged.bytes)
    expect(imageCount(doc)).toBe(1)
    const refs = doc.getPages().map((page) => {
      const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
      return String(xobjects?.values()[0])
    })
    expect(new Set(refs).size).toBe(1)
  })

  it('leaves different pictures alone', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    page.drawImage(await doc.embedPng(PNG), { x: 0, y: 0, width: 1, height: 1 })
    const other = await PDFDocument.create()
    other.addPage()
    expect(dedupeImages(doc)).toBe(0)
  })
})

describe('applyPageSize', () => {
  it('sets 17 × 11 with UserUnit and a centered CropBox — content untouched', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([1920, 1248])
    page.drawText('x')
    const before = page.node.Contents()?.toString()
    expect(applyPageSize(doc, 'tabloid', 'fill')).toBe(1)
    const unit = page.node.lookup(PDFName.of('UserUnit'), PDFNumber).asNumber()
    const crop = page.node.lookup(PDFName.of('CropBox'), PDFArray)
    const [x0, y0, x1, y1] = [0, 1, 2, 3].map((i) => (crop.get(i) as PDFNumber).asNumber())
    expect(((x1 - x0) * unit) / 72).toBeCloseTo(17, 4)
    expect(((y1 - y0) * unit) / 72).toBeCloseTo(11, 4)
    expect(page.node.Contents()?.toString()).toBe(before)
  })
})

describe('addBookmarks', () => {
  it('one per frame, grouped under its Figma section, opening on the outline', async () => {
    const doc = await PDFDocument.create()
    for (let i = 0; i < 4; i += 1) doc.addPage()
    const count = addBookmarks(doc, [
      { page: 0, title: 'Cover' },
      { page: 1, title: 'C01 Outdoor Program', section: 'C – Program' },
      { page: 2, title: 'C02 Reception', section: 'C – Program' },
      { page: 3, title: 'Appendix A' }
    ])
    expect(count).toBe(5) // 4 frames + 1 section
    const saved = await PDFDocument.load(await doc.save())
    const outlines = saved.catalog.lookup(PDFName.of('Outlines'), PDFDict)
    const first = outlines.lookup(PDFName.of('First'), PDFDict)
    const second = first.lookup(PDFName.of('Next'), PDFDict)
    expect(second.lookup(PDFName.of('Title'))?.toString()).toContain('FEFF') // hex text
    expect(second.lookup(PDFName.of('Count'), PDFNumber).asNumber()).toBe(2)
    expect(saved.catalog.get(PDFName.of('PageMode'))?.toString()).toBe('/UseOutlines')
  })
})

describe('countFigmaLinks', () => {
  it('counts links still pointing into Figma, not ordinary web links', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage()
    for (const uri of [
      'https://www.figma.com/proto/K/F?node-id=4374-52511',
      'https://3-form.com/x'
    ]) {
      page.node.addAnnot(
        doc.context.register(
          doc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [0, 0, 10, 10],
            A: { S: 'URI', URI: PDFString.of(uri) }
          })
        )
      )
    }
    expect(countFigmaLinks(doc)).toBe(1)
  })
})
