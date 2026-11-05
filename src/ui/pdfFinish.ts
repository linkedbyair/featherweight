// Finishing passes on the merged PDF: print size, bookmarks, repeated images stored once, and a
// count of links that still point at figma.com. No DOM — tested in Node.

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString
} from 'pdf-lib'

import { nodeIdFromLink } from '../lib/figmaLinks'
import { PageFit, PageSizeId, planPage } from '../lib/pageSize'

/** Sets every page's physical size. Page content is not touched (see lib/pageSize). */
export function applyPageSize(document: PDFDocument, size: PageSizeId, fit: PageFit): number {
  if (size === 'frame') return 0
  let changed = 0
  for (const page of document.getPages()) {
    const media = page.getMediaBox()
    const plan = planPage(media.width, media.height, size, fit)
    if (plan === null) continue
    const shift = (box: number[]): number[] => [
      box[0] + media.x,
      box[1] + media.y,
      box[2] + media.x,
      box[3] + media.y
    ]
    const context = document.context
    page.node.set(PDFName.of('MediaBox'), context.obj(shift(plan.mediaBox)))
    page.node.set(PDFName.of('CropBox'), context.obj(shift(plan.cropBox)))
    for (const box of ['TrimBox', 'BleedBox', 'ArtBox']) page.node.delete(PDFName.of(box))
    page.node.set(PDFName.of('UserUnit'), PDFNumber.of(plan.userUnit))
    changed += 1
  }
  return changed
}

export type BookmarkEntry = {
  /** first page of the frame (0-based) */
  page: number
  title: string
  /** Figma section the frame sits in — consecutive frames in one section are grouped under it */
  section?: string
}

/** Builds the document outline. Returns how many bookmarks were written. */
export function addBookmarks(document: PDFDocument, entries: readonly BookmarkEntry[]): number {
  if (entries.length === 0) return 0
  const context = document.context
  const pages = document.getPages()
  const rootRef = context.nextRef()

  type Node = { title: string; page: number; children: Node[] }
  const top: Node[] = []
  let group: Node | null = null
  for (const entry of entries) {
    const item: Node = { title: entry.title, page: entry.page, children: [] }
    if (entry.section === undefined || entry.section === '') {
      group = null
      top.push(item)
      continue
    }
    if (group === null || group.title !== entry.section) {
      group = { title: entry.section, page: entry.page, children: [] }
      top.push(group)
    }
    group.children.push(item)
  }

  let count = 0
  const write = (nodes: Node[], parent: PDFRef): { first: PDFRef; last: PDFRef; total: number } => {
    const refs = nodes.map(() => context.nextRef())
    let total = 0
    nodes.forEach((node, index) => {
      const target = pages[Math.min(node.page, pages.length - 1)]
      const dict = context.obj({
        Title: PDFHexString.fromText(node.title),
        Parent: parent,
        Dest: [target.ref, PDFName.of('Fit')]
      }) as PDFDict
      if (index > 0) dict.set(PDFName.of('Prev'), refs[index - 1])
      if (index < nodes.length - 1) dict.set(PDFName.of('Next'), refs[index + 1])
      if (node.children.length > 0) {
        const kids = write(node.children, refs[index])
        dict.set(PDFName.of('First'), kids.first)
        dict.set(PDFName.of('Last'), kids.last)
        // negative = closed. Sections open so the chapter list is visible straight away
        dict.set(PDFName.of('Count'), PDFNumber.of(kids.total))
        total += kids.total
      }
      context.assign(refs[index], dict)
      count += 1
      total += 1
    })
    return { first: refs[0], last: refs[refs.length - 1], total }
  }

  const children = write(top, rootRef)
  context.assign(
    rootRef,
    context.obj({
      Type: 'Outlines',
      First: children.first,
      Last: children.last,
      Count: children.total
    })
  )
  document.catalog.set(PDFName.of('Outlines'), rootRef)
  document.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
  return count
}

/**
 * Figma writes each frame's images into that frame's PDF, so a picture used on twenty pages is
 * stored twenty times. Identical image streams (same bytes and same dictionary, soft masks first)
 * become one. Lossless. Returns how many copies were dropped.
 */
export function dedupeImages(document: PDFDocument): number {
  const context = document.context
  const replace = new Map<string, PDFRef>()
  let dropped = 0
  const masks = new Set<string>()
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue
    const mask = object.dict.get(PDFName.of('SMask'))
    if (mask instanceof PDFRef) masks.add(mask.toString())
  }

  // masks first: an image's dictionary names its mask, so masks must be canonical before images match
  for (const pass of ['mask', 'image'] as const) {
    const seen = new Map<string, Array<{ ref: PDFRef; stream: PDFRawStream }>>()
    for (const [ref, object] of context.enumerateIndirectObjects()) {
      if (!(object instanceof PDFRawStream) || !isImage(object)) continue
      if (masks.has(ref.toString()) !== (pass === 'mask')) continue
      const key = `${object.contents.length}:${hashBytes(object.contents)}:${dictKey(object, replace)}`
      const bucket = seen.get(key) ?? []
      const twin = bucket.find((entry) => sameBytes(entry.stream.contents, object.contents))
      if (twin !== undefined) {
        replace.set(ref.toString(), twin.ref)
        dropped += 1
      } else {
        bucket.push({ ref, stream: object })
        seen.set(key, bucket)
      }
    }
  }
  if (replace.size === 0) return 0

  const swap = (value: PDFObject): PDFObject =>
    value instanceof PDFRef ? (replace.get(value.toString()) ?? value) : value
  for (const [, object] of context.enumerateIndirectObjects()) {
    const dict =
      object instanceof PDFDict ? object : object instanceof PDFStream ? object.dict : null
    if (dict !== null) rewrite(dict, swap)
  }
  for (const key of replace.keys()) {
    const [num, gen] = key.split(' ').map(Number)
    context.delete(PDFRef.of(num, gen))
  }
  return dropped
}

function rewrite(dict: PDFDict, swap: (value: PDFObject) => PDFObject): void {
  for (const [key, value] of dict.entries()) {
    if (value instanceof PDFDict) rewrite(value, swap)
    else if (value instanceof PDFArray) {
      for (let i = 0; i < value.size(); i += 1) {
        const item = value.get(i)
        if (item instanceof PDFDict) rewrite(item, swap)
        else value.set(i, swap(item))
      }
    } else dict.set(key, swap(value))
  }
}

function isImage(stream: PDFRawStream): boolean {
  const subtype = stream.dict.get(PDFName.of('Subtype'))
  return subtype instanceof PDFName && subtype.asString() === '/Image'
}

function dictKey(stream: PDFRawStream, replace: ReadonlyMap<string, PDFRef>): string {
  const parts: string[] = []
  for (const [key, value] of stream.dict.entries()) {
    if (key.asString() === '/Length') continue
    const resolved = value instanceof PDFRef ? (replace.get(value.toString()) ?? value) : value
    parts.push(`${key.asString()}=${resolved.toString()}`)
  }
  return parts.sort().join('|')
}

function hashBytes(bytes: Uint8Array): number {
  let hash = 2166136261
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

/**
 * Links that still go to figma.com after relinking — layer links whose target isn't in this export
 * (or was deleted). Worth fixing in Figma before a set goes out: a fabricator can't open them.
 */
export function countFigmaLinks(document: PDFDocument): number {
  let count = 0
  for (const page of document.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    if (annots === undefined) continue
    for (let i = 0; i < annots.size(); i += 1) {
      const annot = annots.lookupMaybe(i, PDFDict)
      const action = annot?.lookupMaybe(PDFName.of('A'), PDFDict)
      const uri = action?.lookup(PDFName.of('URI'))
      const text =
        uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : undefined
      if (text !== undefined && nodeIdFromLink(text) !== null) count += 1
    }
  }
  return count
}
