// Figma 레이어 간 링크를 PDF 안의 쪽 이동으로 잇기 위한 순수 함수. Figma·DOM·pdf-lib 의존 금지.
//
// Figma 의 PDF 내보내기는 프로토타입 연결(On click → Navigate to)과 텍스트의 레이어 링크를
// `https://www.figma.com/proto/<file>/<name>?node-id=12-34…` 웹 링크로 쓴다. PDF 를 받은 사람은
// 그 파일에 접근할 수 없는 경우가 많고, 접근하더라도 문서 안에서 옮겨 가야 할 것이 브라우저로 튄다.
// 대상이 이번 내보내기에 든 프레임이면 그 쪽으로 가는 내부 링크가 맞다.
//
// 우리가 다시 그린 텍스트는 Figma 의 링크 주석을 잃는다. NODE 링크는 URL 이 없으니 아래 스킴으로
// 자리를 잡아 두고, 머지 뒤 같은 패스(ui/pdfLinks)에서 쪽으로 바꾼다. 못 바꾸면 지운다.

/** 다시 그린 텍스트의 NODE 링크 자리표시 — 머지 뒤에 쪽 이동으로 바뀌거나 지워진다 */
export const NODE_LINK_SCHEME = 'featherweight-node:'

/** URL 의 node-id 는 `12-34`, API 의 노드 id 는 `12:34` 다. 인스턴스 안 노드는 `I12:34;56:78` 꼴 */
export function normalizeNodeId(raw: string): string {
  let id = raw
  try {
    id = decodeURIComponent(raw)
  } catch {
    // 잘못된 % 인코딩 — 원문 그대로 본다
  }
  return id.replace(/-/g, ':')
}

const FIGMA_HOST = /(^|\.)figma\.com$/i
const FIGMA_PATH = /^\/(proto|design|file|board|slides|deck)\//i

/**
 * 링크가 가리키는 Figma 노드 id. Figma 링크가 아니거나 node-id 가 없으면 null.
 * 자리표시 스킴도 여기서 푼다 — 호출자는 두 경우를 구분할 필요가 없다.
 */
export function nodeIdFromLink(url: string): string | null {
  if (url.startsWith(NODE_LINK_SCHEME)) {
    const id = url.slice(NODE_LINK_SCHEME.length)
    return id === '' ? null : normalizeNodeId(id)
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!FIGMA_HOST.test(parsed.hostname) || !FIGMA_PATH.test(parsed.pathname)) return null
  const raw = parsed.searchParams.get('node-id')
  return raw === null || raw === '' ? null : normalizeNodeId(raw)
}

/** 텍스트 세그먼트의 링크를 주석 URL 로. NODE 는 자리표시로 */
export function linkUrlOf(hyperlink: { type: 'URL' | 'NODE'; value: string } | null): string {
  if (hyperlink === null || hyperlink.value === '') return ''
  return hyperlink.type === 'URL' ? hyperlink.value : NODE_LINK_SCHEME + hyperlink.value
}
