// 텍스트 run 이 원문의 어느 글자에 해당하는지 찾아, 그 구간에 걸린 URL 링크를 돌려준다. Figma·DOM 의존 금지.
//
// 텍스트를 우리가 다시 그리면 Figma 가 넣던 링크 주석이 사라진다. 세그먼트에는 글자 범위별
// 하이퍼링크가 있고, run 은 SVG 에서 나온 글자 덩어리라 범위가 없다 — 원문 안에서 run 의
// 글자를 순서대로 찾아 범위를 맞춘다. 대소문자 변환(textCase) 등으로 못 찾으면 링크를 안 넣는다.
// 없는 게 엉뚱한 자리에 있는 것보다 낫다.
//
// 원문에는 묶음문자 같은 폭 0 서식 문자가 섞여 있을 수 있고 run 에서는 그것을 뺀다 —
// 맞출 때 원문 쪽의 그 문자는 건너뛰고, run 기준 인덱스는 그것을 뺀 수로 센다.

import { linkUrlOf } from './figmaLinks'
import { isIgnorable } from './ignorable'
import { TextSegment } from './types'

/** run 안의 글자 범위(run 기준 인덱스)와 URL. NODE 링크는 figmaLinks 의 자리표시 URL 이다 */
export type LinkSpan = { start: number; end: number; url: string }

/** 밑줄·취소선이 걸린 run 안의 글자 범위(run 기준 인덱스) */
export type DecorationSpan = {
  start: number
  end: number
  kind: 'UNDERLINE' | 'STRIKETHROUGH'
  /** 세그먼트가 정한 모양(TextSegment.decoration) — 없으면 폰트 메트릭과 글자색 */
  style?: TextSegment['decoration']
}

/** 원문에서 run 의 글자가 시작·끝나는 자리(원문 인덱스). 원문의 무시 문자는 건너뛴다. */
export function locateRun(
  characters: string,
  cursor: number,
  runText: string
): { start: number; end: number } | null {
  for (let start = cursor; start < characters.length; start += 1) {
    let i = start
    let j = 0
    while (j < runText.length) {
      if (i >= characters.length) return null
      const code = characters.codePointAt(i) ?? 0
      if (isIgnorable(code)) {
        i += 1
        continue
      }
      if (characters[i] !== runText[j]) break
      i += 1
      j += 1
    }
    if (j === runText.length) return { start, end: i }
  }
  return null
}

export function linkSpansForRun(
  characters: string,
  cursor: number,
  runText: string,
  segments: readonly TextSegment[]
): { spans: LinkSpan[]; next: number } {
  const { links, next } = spansForRun(characters, cursor, runText, segments)
  return { spans: links, next }
}

/**
 * run 하나가 원문의 어디인지 한 번 찾고, 그 구간에 걸린 링크와 밑줄·취소선을 함께 돌려준다.
 * 둘을 따로 찾으면 커서가 두 번 움직여 둘째부터 어긋난다.
 */
export function spansForRun(
  characters: string,
  cursor: number,
  runText: string,
  segments: readonly TextSegment[]
): { links: LinkSpan[]; decorations: DecorationSpan[]; next: number } {
  if (runText === '') return { links: [], decorations: [], next: cursor }
  const located = locateRun(characters, cursor, runText)
  if (located === null) return { links: [], decorations: [], next: cursor }
  const { start: at, end: runEnd } = located

  // 원문 인덱스 → run 기준 인덱스: 그 사이의 무시 문자는 run 에 없다
  const toRun = (index: number): number => {
    let count = 0
    for (let i = at; i < index; i += 1) if (!isIgnorable(characters.codePointAt(i) ?? 0)) count += 1
    return count
  }

  const links: LinkSpan[] = []
  const decorations: DecorationSpan[] = []
  for (const segment of segments) {
    const start = toRun(Math.max(segment.start, at))
    const end = toRun(Math.min(segment.end, runEnd))
    if (end <= start) continue

    const url = linkUrlOf(segment.hyperlink)
    if (url !== '') {
      const last = links[links.length - 1]
      // 같은 URL 이 이어지면 한 구간으로 — 세그먼트가 굵기 때문에 갈라져 있을 수 있다
      if (last !== undefined && last.url === url && last.end === start) last.end = end
      else links.push({ start, end, url })
    }

    const kind = segment.textDecoration
    if (kind === 'UNDERLINE' || kind === 'STRIKETHROUGH') {
      const last = decorations[decorations.length - 1]
      const style = segment.decoration
      const same =
        last !== undefined &&
        last.kind === kind &&
        last.end === start &&
        JSON.stringify(last.style) === JSON.stringify(style)
      if (same) last.end = end
      else decorations.push({ start, end, kind, ...(style === undefined ? {} : { style }) })
    }
  }
  return { links, decorations, next: runEnd }
}
