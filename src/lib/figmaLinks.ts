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
 * URL 을 손으로 가른다. Figma 플러그인의 메인 스레드에는 `URL`·`URLSearchParams` 가 없다 —
 * 그 안에서 `new URL()` 은 던지고, 링크 대상을 모으던 순회가 통째로 멈춘다.
 */
function splitUrl(url: string): { host: string; path: string; query: string } | null {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i.exec(url.trim())
  if (match === null) return null
  const host = match[1].replace(/:\d+$/, '').replace(/^[^@]*@/, '')
  return { host, path: match[2] === '' ? '/' : match[2], query: match[3] ?? '' }
}

function queryParam(query: string, name: string): string | null {
  for (const pair of query.split('&')) {
    const at = pair.indexOf('=')
    const key = at < 0 ? pair : pair.slice(0, at)
    if (key === name) return at < 0 ? '' : pair.slice(at + 1).replace(/\+/g, ' ')
  }
  return null
}

/** figma.com 의 파일 링크면 그 조각들 */
function figmaParts(url: string): { path: string; query: string } | null {
  const parts = splitUrl(url)
  if (parts === null || !FIGMA_HOST.test(parts.host) || !FIGMA_PATH.test(parts.path)) return null
  return parts
}

/**
 * 링크가 가리키는 Figma 노드 id. Figma 링크가 아니거나 node-id 가 없으면 null.
 * 자리표시 스킴도 여기서 푼다 — 호출자는 두 경우를 구분할 필요가 없다.
 */
export function nodeIdFromLink(url: string): string | null {
  if (url.startsWith(NODE_LINK_SCHEME)) {
    const id = url.slice(NODE_LINK_SCHEME.length)
    return id === '' ? null : normalizeNodeId(id)
  }
  const parts = figmaParts(url)
  if (parts === null) return null
  const raw = queryParam(parts.query, 'node-id')
  return raw === null || raw === '' ? null : normalizeNodeId(raw)
}

/** 텍스트 세그먼트의 링크를 주석 URL 로. NODE 는 자리표시로 */
export function linkUrlOf(hyperlink: { type: 'URL' | 'NODE'; value: string } | null): string {
  if (hyperlink === null || hyperlink.value === '') return ''
  return hyperlink.type === 'URL' ? hyperlink.value : NODE_LINK_SCHEME + hyperlink.value
}

/** figma.com 링크의 파일 키 (`/proto/<key>/…`). Figma 링크가 아니면 null */
export function fileKeyFromLink(url: string): string | null {
  const parts = figmaParts(url)
  return parts === null ? null : parts.path.split('/')[2] || null
}
