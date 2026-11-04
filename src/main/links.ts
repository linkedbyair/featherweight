// 프레임 안의 레이어 간 링크가 이번 내보내기의 어느 프레임으로 가는지 미리 풀어 둔다. (lib/figmaLinks)
//
// Figma 의 PDF 는 이 링크들을 figma.com 웹 링크로 쓴다. 노드 id → 프레임 index 를 여기서 만들어
// 두면 UI 가 머지 뒤 그 링크를 PDF 안의 쪽 이동으로 바꾼다. 이 프레임이 실제로 가진 링크의 대상만
// 넣으므로, 다른 파일을 가리키는 figma.com 링크가 우연히 같은 node-id 를 가져도 바뀌지 않는다.

import { normalizeNodeId } from '../lib/figmaLinks'

/** 링크 대상을 모으는 데 걸리는 시간이 내보내기를 막지 않게 — 넘으면 모은 데까지만 */
const COLLECT_BUDGET_MS = 5_000

/**
 * 원본 프레임(클론이 아니라 — 클론은 내보낸 뒤 지워지고, 리액션은 원본에 있다)에서
 * 링크 대상을 모아 내보내는 프레임 index 로 푼다. 실패해도 던지지 않는다.
 */
export async function collectLinkTargets(
  frame: SceneNode,
  frameOrder: readonly string[]
): Promise<Record<string, number>> {
  const targets = new Set<string>()
  try {
    collectTargetIds(frame, targets, Date.now() + COLLECT_BUDGET_MS)
  } catch {
    // 일부 노드의 리액션·세그먼트를 못 읽어도 모은 것은 쓴다
  }
  if (targets.size === 0) return {}

  const indexOf = new Map(frameOrder.map((id, index) => [id, index]))
  const resolved: Record<string, number> = {}
  for (const id of targets) {
    const index = await frameIndexOf(id, indexOf)
    if (index !== null) resolved[normalizeNodeId(id)] = index
  }
  return resolved
}

/** 프로토타입 리액션의 이동 대상과 텍스트의 NODE 링크 대상 */
export function collectTargetIds(root: SceneNode, out: Set<string>, deadline: number): void {
  const visit = (node: SceneNode): void => {
    if (Date.now() > deadline) return
    if ('reactions' in node) {
      for (const reaction of node.reactions) {
        // 예전 API 는 action 하나, 지금은 actions 배열이다 — 둘 다 본다
        const legacy = (reaction as { action?: Action | null }).action
        const actions = reaction.actions ?? (legacy ? [legacy] : [])
        for (const action of actions) {
          if (action.type !== 'NODE' || action.destinationId === null) continue
          // 오버레이·스왑은 쪽이 바뀌는 이동이 아니다. 이동·스크롤만
          if (action.navigation === 'NAVIGATE' || action.navigation === 'SCROLL_TO')
            out.add(action.destinationId)
        }
      }
    }
    if (node.type === 'TEXT' && node.characters !== '') {
      for (const segment of node.getStyledTextSegments(['hyperlink'])) {
        if (segment.hyperlink?.type === 'NODE' && segment.hyperlink.value !== undefined)
          out.add(segment.hyperlink.value)
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
