// PDF 머지·저장. mergePdfs 는 DOM 을 안 쓰므로 Node 에서 테스트한다. (PRD §11)

import { t } from '../lib/i18n'
import { NODE_LINK_SCHEME } from '../lib/figmaLinks'
import { PageFit, PageSizeId } from '../lib/pageSize'
import { LeftoverPicture, LinkArea, Reason } from '../lib/types'
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFImage,
  PDFName,
  PDFNumber,
  PDFPage,
  PDFRawStream,
  PDFStream,
  PDFString
} from 'pdf-lib'

import { DrawResult, DrawSubstitution } from './textLayer'
import { addBookmarks, applyPageSize, countFigmaLinks, dedupeImages } from './pdfFinish'
import { relinkToPages } from './pdfLinks'

export type MergePart = { index: number; bytes: Uint8Array }

export type MergeMeta = {
  title: string
  createdAt: Date
  /** Phase 2: 페이지를 붙인 직후 그 위에 진짜 폰트로 텍스트를 얹는다 */
  drawText?: (document: PDFDocument, page: PDFPage, partIndex: number) => Promise<DrawResult>
  /** 우리가 Figma 에 넣은 이미지의 치수("WxH") — PDF 안에서 우리 것과 Figma 가 스스로 래스터화한 것을 가른다 */
  ownImageSizes?: ReadonlySet<string>
  /**
   * 레이어 간 링크 대상(노드 id → 프레임 index). 주면 머지 뒤 figma.com 링크를 PDF 안의 쪽
   * 이동으로 바꾼다 (ui/pdfLinks). 주지 않으면 링크를 건드리지 않는다.
   */
  linkTargets?: ReadonlyMap<string, number>
  /** 프레임 index → 리액션 링크 자리. 첫 쪽에 자리표시 링크로 달고, 아래 relink 가 쪽 이동으로 바꾼다 */
  linkAreas?: ReadonlyMap<number, readonly LinkArea[]>
  /** Print size for every page (lib/pageSize). Omitted or 'frame' leaves pages at frame size */
  pageSize?: { size: PageSizeId; fit: PageFit }
  /** One bookmark per frame (frame index → title and section). Omitted: no outline */
  bookmarks?: ReadonlyArray<{ index: number; title: string; section?: string }>
}

export type MergeOutput = PdfContents & {
  bytes: Uint8Array
  textDrawn: number
  textFallbacks: Array<{ nodeId: string; reason: Reason }>
  /** 대체 폰트로 그린 글자들 (노드별) */
  textSubstitutions: DrawSubstitution[]
  /** figma.com 레이어 링크를 쪽 이동으로 바꾼 개수 (linkTargets 를 줬을 때) */
  linksRelinked: number
  /** links still pointing at figma.com after relinking (targets outside this export) */
  figmaLinksLeft: number
  /** identical image copies stored once */
  imagesShared: number
  bookmarksAdded: number
}

/**
 * Figma 가 아웃라인 텍스트를 내보내는 방식은 Type 3 폰트다 — 글리프 하나가 벡터
 * 프로그램이고, 폰트·크기·스타일 조합마다 새 객체가 생긴다. 그래서 텍스트만 있는
 * 문서가 10~20MB 로 부푼다.
 *
 * 이걸 세는 이유 둘:
 *   · 사용자에게 "아웃라인으로 남은 텍스트가 몇 MB 인지" 알려 준다. 개수만으로는
 *     폰트를 추가할 이유가 안 와닿는다.
 *   · 우리 파이프라인의 누수를 잡는다. 전부 임베드했는데 Type 3 가 남아 있으면,
 *     글리프를 못 지운 것이다 (유령 텍스트 버그).
 */
/** 만들어진 PDF 를 되읽어 실제로 뭐가 들었는지 잰다 */
export type PdfContents = {
  /** 실제 페이지 수. 프레임 하나가 여러 쪽으로 나뉠 수 있어 부분 개수와 다를 수 있다. */
  pageCount: number
  outlines: OutlineCost
  images: ImageWeight
}

/**
 * PDF 안의 이미지 실측.
 *
 * ⚠ 우리가 Figma 에 건넨 바이트와 다르다. createImage 로 꽂은 이미지를 Figma 가
 * exportAsync 할 때 자기 방식으로 다시 인코딩한다 — 23.4MB PNG 를 넘겼는데 PDF 에는
 * 1.7MB JPEG 로 들어간 적이 있다. 사용자에게는 파일에 실제로 든 것을 말해야 한다.
 */
export type ImageWeight = {
  /** 알파 마스크(smask)는 빼고 센 장수 */
  count: number
  bytes: number
  /**
   * bytes 중 우리가 넣은 이미지(치수가 일치)와 그 알파 마스크의 몫. 나머지는 Figma 가 그림자·마스크
   * 같은 것을 스스로 래스터화한 것이라 우리 이미지 설정으로는 안 움직인다. 치수를 안 주면 bytes 와 같다
   */
  own: number
}

export type OutlineCost = {
  /** 남은 Type 3 폰트 개수. 우리가 글리프를 못 지웠는지 잡아내는 신호다. */
  fonts: number
  /**
   * 페이지 콘텐츠 스트림의 총 바이트 — 벡터로 그려진 것들의 무게다.
   *
   * 아웃라인 텍스트는 여기 들어간다. 실측한 경쟁 제품의 5쪽 이력서는 이 값이 7.7MB
   * 였고 (파일 9.2MB), 같은 문서를 폰트로 임베드한 우리 결과는 0.25MB 였다.
   * 이미지 배치나 우리가 그린 텍스트 연산도 섞이지만 그쪽은 무시할 만큼 작다.
   */
  vectorBytes: number
}

export const PRODUCER = 'Airweight'

/**
 * 그림으로 바꾼 글자(이모지가 섞인 라벨)를 제자리에 얹는다. 좌표는 프레임 기준(아래로 +y).
 * 같은 그림은 한 번만 넣는다 — 같은 라벨이 여러 쪽에 되풀이된다.
 */
export async function drawPictures(
  document: PDFDocument,
  page: PDFPage,
  pictures: readonly LeftoverPicture[],
  embedded: Map<string, PDFImage> = pictureCache(document)
): Promise<void> {
  const height = page.getHeight()
  for (const picture of pictures) {
    const key = fingerprint(picture.png)
    let image = embedded.get(key)
    if (image === undefined) {
      image = await document.embedPng(picture.png)
      embedded.set(key, image)
    }
    page.drawImage(image, {
      x: picture.x,
      y: height - picture.y - picture.height,
      width: picture.width,
      height: picture.height
    })
  }
}

const caches = new WeakMap<PDFDocument, Map<string, PDFImage>>()

function pictureCache(document: PDFDocument): Map<string, PDFImage> {
  let cache = caches.get(document)
  if (cache === undefined) {
    cache = new Map()
    caches.set(document, cache)
  }
  return cache
}

/** 같은 PNG 인지 — 길이와 전체 바이트의 해시(같은 라벨을 같은 배율로 찍은 것은 바이트가 같다) */
function fingerprint(bytes: Uint8Array): string {
  let hash = 0
  for (let i = 0; i < bytes.length; i += 1) hash = (hash * 31 + bytes[i]) | 0
  return `${bytes.length}:${hash}`
}

/**
 * 리액션 링크 자리를 링크 주석으로. URL 은 NODE 자리표시라 relinkToPages 가 쪽 이동으로 바꾸거나
 * 지운다 — 대상이 이번 내보내기에 없으면 남지 않는다. 좌표는 프레임 기준(아래로 +y)이다.
 */
export function addAreaLinks(page: PDFPage, areas: readonly LinkArea[]): void {
  const height = page.getHeight()
  const context = page.doc.context
  for (const area of areas) {
    const annot = context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [area.x, height - area.y - area.height, area.x + area.width, height - area.y],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(NODE_LINK_SCHEME + area.target) }
    })
    page.node.addAnnot(context.register(annot))
  }
}

/**
 * 부분 PDF 들을 index 순으로 이어 붙인다.
 * 프레임 1개는 보통 1페이지지만, 여러 페이지가 나와도 순서대로 다 가져온다.
 */
export async function mergePdfs(
  parts: readonly MergePart[],
  meta: MergeMeta
): Promise<MergeOutput> {
  if (parts.length === 0) throw new Error(t('pdf.noParts'))

  const ordered = [...parts].sort((a, b) => a.index - b.index)
  const out = await PDFDocument.create()
  let textDrawn = 0
  const textFallbacks: Array<{ nodeId: string; reason: Reason }> = []
  const textSubstitutions: DrawSubstitution[] = []
  const firstPageOfFrame = new Map<number, number>()

  for (const part of ordered) {
    const source = await PDFDocument.load(part.bytes)
    const pages = await out.copyPages(source, source.getPageIndices())
    firstPageOfFrame.set(part.index, out.getPageCount())
    for (const [index, page] of pages.entries()) {
      out.addPage(page)
      if (index === 0) addAreaLinks(page, meta.linkAreas?.get(part.index) ?? [])
      if (meta.drawText === undefined) continue
      // 텍스트 좌표는 프레임 하나를 기준으로 잰 것이다. 한 프레임이 여러 쪽으로
      // 나뉘면 둘째 쪽부터는 그 좌표가 맞지 않는다 — 같은 문장을 쪽마다 겹쳐 그리게
      // 되므로 첫 쪽에만 얹는다. (실제로는 프레임 1개 = 1쪽이라 거의 안 걸린다)
      if (index > 0) continue
      const drawn = await meta.drawText(out, page, part.index)
      textDrawn += drawn.drawn
      textFallbacks.push(...drawn.fallbacks)
      textSubstitutions.push(...drawn.substitutions)
    }
  }

  // 모든 쪽이 붙은 뒤에야 대상 쪽의 참조가 있다 — 그래서 머지 끝에서 한 번에 바꾼다
  const linksRelinked =
    meta.linkTargets !== undefined && meta.linkTargets.size > 0
      ? relinkToPages(out, meta.linkTargets, firstPageOfFrame).relinked
      : 0

  const figmaLinksLeft = countFigmaLinks(out)
  const bookmarksAdded =
    meta.bookmarks === undefined
      ? 0
      : addBookmarks(
          out,
          meta.bookmarks.flatMap((entry) => {
            const page = firstPageOfFrame.get(entry.index)
            return page === undefined
              ? []
              : [{ page, title: entry.title, ...(entry.section ? { section: entry.section } : {}) }]
          })
        )
  if (meta.pageSize !== undefined) applyPageSize(out, meta.pageSize.size, meta.pageSize.fit)
  const imagesShared = dedupeImages(out)

  out.setTitle(meta.title)
  out.setProducer(PRODUCER)
  out.setCreator(PRODUCER)
  out.setCreationDate(meta.createdAt)
  out.setModificationDate(meta.createdAt)

  const contents = measurePdf(out, meta.ownImageSizes)

  // save() 는 메타데이터를 건드리지 않는다. 덮어쓰는 쪽은 PDFDocument.load/create 이므로
  // 결과를 다시 읽어 확인할 때는 load(bytes, { updateMetadata: false }) 로 열어야 한다.
  return {
    bytes: await out.save({ useObjectStreams: true }),
    textDrawn,
    textFallbacks,
    textSubstitutions,
    linksRelinked,
    figmaLinksLeft,
    imagesShared,
    bookmarksAdded,
    ...contents
  }
}

/**
 * 아웃라인의 무게를 잰다 — Type 3 폰트 개수와 페이지 벡터 콘텐츠의 바이트.
 * 둘 다 압축된 실제 크기로 센다 (파일에서 차지하는 몫).
 */
function measurePdf(document: PDFDocument, ownImageSizes?: ReadonlySet<string>): PdfContents {
  return {
    pageCount: document.getPageCount(),
    outlines: measureOutlines(document),
    images: measureImages(document, ownImageSizes)
  }
}

/**
 * 이미지 XObject 의 장수와 압축된 바이트. smask 는 본체에 딸린 것이라 장수에 세지 않는다.
 * ownSizes(우리가 넣은 이미지의 "WxH")를 주면 치수가 일치하는 이미지와 그 smask 의 바이트를 own 으로 따로
 * 센다 — 실측(2026-09-12): 그림자 효과가 있는 프레임을 Figma 가 3204×5538 JPEG+알파로 통째 래스터화해
 * 쪽마다 15 MB 를 넣었다. 그건 우리 이미지 설정과 무관하니 목표 용량 예측에서는 고정분이다.
 */
export function measureImages(document: PDFDocument, ownSizes?: ReadonlySet<string>): ImageWeight {
  // 알파 채널(smask)도 /Subtype /Image 이고 ColorSpace 도 갖는다 — 본체가 /SMask 로
  // 가리키는 대상을 먼저 모아 두고 빼야 장수가 두 배로 세어지지 않는다. 본체가 우리 것이면 마스크도 우리 것
  const masks = new Map<string, boolean>()
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue
    const mask = object.dict.get(PDFName.of('SMask'))
    if (mask !== undefined) masks.set(String(mask), isOwnImage(object, ownSizes))
  }

  let count = 0
  let bytes = 0
  let own = 0
  for (const [ref, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFStream)) continue
    const subtype = object.dict.get(PDFName.of('Subtype'))
    if (!(subtype instanceof PDFName) || subtype.asString() !== '/Image') continue

    const size = object instanceof PDFRawStream ? object.contents.length : object.sizeInBytes()
    bytes += size
    const maskOfOwn = masks.get(String(ref))
    if (maskOfOwn === undefined) count += 1
    if (maskOfOwn ?? isOwnImage(object, ownSizes)) own += size
  }

  return { count, bytes, own }
}

function isOwnImage(object: PDFStream, ownSizes: ReadonlySet<string> | undefined): boolean {
  if (ownSizes === undefined) return true
  const width = object.dict.get(PDFName.of('Width'))
  const height = object.dict.get(PDFName.of('Height'))
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) return false
  return ownSizes.has(`${width.asNumber()}x${height.asNumber()}`)
}

function measureOutlines(document: PDFDocument): OutlineCost {
  let fonts = 0
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue
    const subtype = object.get(PDFName.of('Subtype'))
    if (subtype instanceof PDFName && subtype.asString() === '/Type3') fonts += 1
  }

  let vectorBytes = 0
  for (const page of document.getPages()) {
    // Contents 는 스트림 하나일 수도, 스트림 참조의 배열일 수도 있다
    const contents = document.context.lookup(page.node.get(PDFName.of('Contents')))
    const streams =
      contents instanceof PDFArray
        ? contents.asArray().map((ref) => document.context.lookup(ref))
        : [contents]
    for (const stream of streams) {
      if (stream instanceof PDFRawStream) vectorBytes += stream.contents.length
      else if (stream instanceof PDFStream) vectorBytes += stream.sizeInBytes()
    }
  }

  return { fonts, vectorBytes }
}

/** iframe 안에서 a[download] 로 저장 다이얼로그를 띄운다. */
export function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
