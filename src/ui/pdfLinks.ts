// 머지가 끝난 PDF 의 figma.com 레이어 링크를 문서 안의 쪽 이동으로 바꾼다. (lib/figmaLinks)
// DOM 을 안 쓰므로 Node 에서 테스트한다.

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib'

import { NODE_LINK_SCHEME, nodeIdFromLink } from '../lib/figmaLinks'

export type RelinkResult = {
  /** figma.com 링크·자리표시가 쪽 이동이 된 개수 */
  relinked: number
  /** 대상이 이번 내보내기 밖이라 지운 자리표시(우리가 다시 그린 텍스트의 NODE 링크) 개수 */
  dropped: number
}

/**
 * targets: 노드 id → 프레임 index (main/links 가 푼 것)
 * firstPageOfFrame: 프레임 index → 그 프레임이 시작하는 쪽 번호(0부터)
 *
 * 대상을 못 찾은 figma.com 링크는 그대로 둔다 — 원래 Figma 가 넣은 웹 링크이고, 이번 내보내기에
 * 없는 레이어를 가리킬 뿐이다. 우리 자리표시는 웹에서 열 수 없으니 지운다.
 */
export function relinkToPages(
  document: PDFDocument,
  targets: ReadonlyMap<string, number>,
  firstPageOfFrame: ReadonlyMap<number, number>
): RelinkResult {
  const result: RelinkResult = { relinked: 0, dropped: 0 }
  const pages = document.getPages()
  const context = document.context

  for (const page of pages) {
    const annots = context.lookupMaybe(page.node.get(PDFName.of('Annots')), PDFArray)
    if (annots === undefined) continue

    const keep: Array<PDFRef | PDFDict> = []
    let changed = false
    for (const entry of annots.asArray()) {
      const annot = context.lookupMaybe(entry, PDFDict)
      const url = annot === undefined ? null : linkUriOf(document, annot)
      const id = url === null ? null : nodeIdFromLink(url)
      if (annot === undefined || url === null || id === null) {
        keep.push(entry as PDFRef | PDFDict)
        continue
      }

      const frame = targets.get(id)
      const pageIndex = frame === undefined ? undefined : firstPageOfFrame.get(frame)
      const target = pageIndex === undefined ? undefined : pages[pageIndex]
      if (target !== undefined) {
        annot.delete(PDFName.of('A'))
        annot.set(PDFName.of('Dest'), context.obj([target.ref, PDFName.of('Fit')]))
        result.relinked += 1
        changed = true
        keep.push(entry as PDFRef | PDFDict)
      } else if (url.startsWith(NODE_LINK_SCHEME)) {
        result.dropped += 1
        changed = true
      } else {
        keep.push(entry as PDFRef | PDFDict)
      }
    }
    if (changed) page.node.set(PDFName.of('Annots'), context.obj(keep))
  }
  return result
}

/** /Subtype /Link 이고 /A 가 URI 동작이면 그 URI */
function linkUriOf(document: PDFDocument, annot: PDFDict): string | null {
  const subtype = annot.get(PDFName.of('Subtype'))
  if (!(subtype instanceof PDFName) || subtype.asString() !== '/Link') return null
  const action = document.context.lookupMaybe(annot.get(PDFName.of('A')), PDFDict)
  if (action === undefined) return null
  const kind = action.get(PDFName.of('S'))
  if (!(kind instanceof PDFName) || kind.asString() !== '/URI') return null
  const uri = document.context.lookup(action.get(PDFName.of('URI')))
  if (uri instanceof PDFString || uri instanceof PDFHexString) return uri.decodeText()
  return null
}
