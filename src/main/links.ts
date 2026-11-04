// 프레임 안의 레이어 간 링크가 이번 내보내기의 어느 프레임으로 가는지 미리 풀어 둔다. (lib/figmaLinks)
//
// Figma 의 PDF 는 이 링크들을 figma.com 웹 링크로 쓴다. 노드 id → 프레임 index 를 여기서 만들어
// 두면 UI 가 머지 뒤 그 링크를 PDF 안의 쪽 이동으로 바꾼다. 이 프레임이 실제로 가진 링크의 대상만
// 넣으므로, 다른 파일을 가리키는 figma.com 링크가 우연히 같은 node-id 를 가져도 바뀌지 않는다.

import { fileKeyFromLink, nodeIdFromLink, normalizeNodeId } from '../lib/figmaLinks'
import { LinkArea } from '../lib/types'

/** 링크 대상을 모으는 데 걸리는 시간이 내보내기를 막지 않게 — 넘으면 모은 데까지만 */
const COLLECT_BUDGET_MS = 5_000

/**
 * 원본 프레임(클론이 아니라 — 클론은 내보낸 뒤 지워지고, 리액션은 원본에 있다)에서
 * 링크 대상을 모아 내보내는 프레임 index 로 푼다. 실패해도 던지지 않는다.
 *
 * areas: 프로토타입 리액션이 걸린 레이어의 자리(프레임 기준, 아래로 +y). 플러그인의 exportAsync
 * PDF 에는 리액션 링크가 실리지 않는다(파일 메뉴의 "프레임을 PDF 로" 와 다르다) — UI 가 이 자리에
 * 링크 주석을 달고, 머지 뒤 쪽 이동으로 바꾼다. 대상이 내보내기 밖이면 그 자리는 버린다.
 */
export async function collectLinks(
  frame: SceneNode,
  frameOrder: readonly string[]
): Promise<{ targets: Record<string, number>; areas: LinkArea[] }> {
  const found: Found = { targets: new Set(), areas: [] }
  try {
    collectTargetIds(frame, found, Date.now() + COLLECT_BUDGET_MS)
  } catch {
    // 일부 노드의 리액션·세그먼트를 못 읽어도 모은 것은 쓴다
  }
  if (found.targets.size === 0) return { targets: {}, areas: [] }

  const indexOf = new Map(frameOrder.map((id, index) => [id, index]))
  const targets: Record<string, number> = {}
  for (const id of found.targets) {
    const index = await frameIndexOf(id, indexOf)
    if (index !== null) targets[normalizeNodeId(id)] = index
  }

  const frameBox = frame.absoluteBoundingBox
  const areas: LinkArea[] = []
  if (frameBox !== null) {
    for (const area of found.areas) {
      if (targets[normalizeNodeId(area.target)] === undefined) continue
      const clipped = clip(area.box, frameBox)
      if (clipped !== null) areas.push({ ...clipped, target: normalizeNodeId(area.target) })
    }
  }
  return { targets, areas }
}

/** 예전 이름 — 대상 표만 */
export async function collectLinkTargets(
  frame: SceneNode,
  frameOrder: readonly string[]
): Promise<Record<string, number>> {
  return (await collectLinks(frame, frameOrder)).targets
}

type Box = { x: number; y: number; width: number; height: number }

type Found = { targets: Set<string>; areas: Array<{ box: Box; target: string }> }

/** 프레임 기준 좌표로 옮기고 프레임 밖은 자른다. 남는 게 없으면 null */
function clip(box: Box, frame: Box): Omit<LinkArea, 'target'> | null {
  const x0 = Math.max(box.x, frame.x)
  const y0 = Math.max(box.y, frame.y)
  const x1 = Math.min(box.x + box.width, frame.x + frame.width)
  const y1 = Math.min(box.y + box.height, frame.y + frame.height)
  if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return null
  return { x: x0 - frame.x, y: y0 - frame.y, width: x1 - x0, height: y1 - y0 }
}

/**
 * 텍스트의 URL 링크가 이 파일의 figma.com 링크인가. 플러그인에서 figma.fileKey 는 비어 있을 수
 * 있다 — 그때는 노드가 실제로 이번 내보내기 프레임 안에 있어야만 바뀌므로(frameIndexOf) 다른
 * 파일의 링크가 우연히 같은 node-id 를 가져도 대개 대상을 못 찾고 그대로 남는다.
 */
function sameFileNodeId(url: string): string | null {
  const id = nodeIdFromLink(url)
  if (id === null) return null
  const own = (figma as { fileKey?: string }).fileKey
  const key = fileKeyFromLink(url)
  if (own !== undefined && own !== '' && key !== null && key !== own) return null
  return id
}

/** 프로토타입 리액션의 이동 대상과 텍스트의 NODE·이 파일 figma.com 링크 대상 */
export function collectTargetIds(
  root: SceneNode,
  out: Found | Set<string>,
  deadline: number
): void {
  const found: Found = out instanceof Set ? { targets: out, areas: [] } : out
  const visit = (node: SceneNode): void => {
    if (Date.now() > deadline) return
    if (node.visible === false) return
    if ('reactions' in node) {
      for (const reaction of node.reactions) {
        // 예전 API 는 action 하나, 지금은 actions 배열이다 — 둘 다 본다
        const legacy = (reaction as { action?: Action | null }).action
        const actions = reaction.actions ?? (legacy ? [legacy] : [])
        for (const action of actions) {
          if (action.type !== 'NODE' || action.destinationId === null) continue
          // 오버레이·스왑은 쪽이 바뀌는 이동이 아니다. 이동·스크롤만
          if (action.navigation !== 'NAVIGATE' && action.navigation !== 'SCROLL_TO') continue
          found.targets.add(action.destinationId)
          // 클릭으로만 — 호버·드래그 같은 방아쇠는 PDF 링크가 아니다
          const trigger = reaction.trigger?.type
          const box = node.absoluteBoundingBox
          if (
            (trigger === 'ON_CLICK' || trigger === 'ON_PRESS' || trigger === undefined) &&
            box !== null
          )
            found.areas.push({ box, target: action.destinationId })
        }
      }
    }
    if (node.type === 'TEXT' && node.characters !== '') {
      for (const segment of node.getStyledTextSegments(['hyperlink'])) {
        const link = segment.hyperlink
        if (link?.type === 'NODE' && link.value !== undefined) found.targets.add(link.value)
        if (link?.type === 'URL' && link.value !== undefined) {
          const id = sameFileNodeId(link.value)
          if (id !== null) found.targets.add(id)
        }
      }
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(root)
}

/** 대상 노드를 품은 내보내는 프레임 — 대상이 프레임 자신이거나 그 안의 레이어면 그 프레임 */
async function frameIndexOf(
  id: string,
  indexOf: ReadonlyMap<string, number>
): Promise<number | null> {
  try {
    let node: BaseNode | null = await figma.getNodeByIdAsync(id)
    while (node !== null && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      const index = indexOf.get(node.id)
      if (index !== undefined) return index
      node = node.parent
    }
  } catch {
    // 지워졌거나 못 읽는 노드 — 링크는 원래대로 둔다
  }
  return null
}
