// 텍스트를 진짜 폰트로 다시 그리기 위한 재료를 뽑고, 원래 글리프를 지운다. (PRD FR-7)
//
// Figma 는 텍스트를 Type 3 폰트로 내보낸다 — 한글이면 이게 파일의 84% 다.
// fill 을 비우면 그 글리프가 빠지고, UI 가 같은 자리에 진짜 폰트로 다시 그린다.

import { transformScale } from '../lib/imageTarget'
import { FontRef, Reason, TextRunSource, TextSegment } from '../lib/types'
import { withTimeout } from '../lib/withTimeout'
import { markTemporary } from './temporary'

/** SVG 추출 한도 — 응답 없는 노드 하나가 내보내기 전체를 멈추지 않게 */
const SVG_TIMEOUT_MS = 15_000

export type TextCandidate = {
  node: TextNode
  source: TextRunSource
  fontRefs: FontRef[]
}

/** 똑바로 세운 사본을 둘 자리 — 내보내는 클론들(exporter 의 OFFSCREEN_X)과도 겹치지 않게 더 멀리 */
const STRAIGHT_COPY_X = -200_000

/** 회전·뒤집기가 없는 변환 — offset 만으로 자리를 옮긴다 (예전 그대로의 길) */
export function isAxisAligned(transform: Transform): boolean {
  const [[a, c], [b, d]] = transform
  return Math.abs(b) <= 1e-6 && Math.abs(c) <= 1e-6 && a > 0 && d > 0
}

/**
 * 회전·뒤집기·기울이기·배율이 섞인 변환도 PDF 의 cm 하나로 그대로 옮길 수 있다. 못 옮기는 것은
 * 역행렬이 없는(한 축이 0 으로 눌린) 변환뿐이다 — 글자가 선으로 보이는 자리라 다시 그릴 것도 없다.
 */
function isInvertible(node: TextNode): boolean {
  const [[a, c], [b, d]] = node.absoluteTransform
  return Math.abs(a * d - b * c) > 1e-6
}

/**
 * 처리 대상 판정. 하나라도 어긋나면 아웃라인을 그대로 두고 사유를 남긴다.
 * "안 되면 원래대로" 가 이 기능의 안전장치다 — 절대 다른 폰트로 대체하지 않는다.
 */
export function screenTextNode(
  node: TextNode,
  root?: BaseNode
): { ok: true } | { ok: false; reason: Reason } {
  if (node.visible === false) return { ok: false, reason: { code: 'reject.hidden' } }
  if (node.characters === '') return { ok: false, reason: { code: 'reject.empty' } }
  if (!isInvertible(node)) return { ok: false, reason: { code: 'reject.rotated' } }

  // 패스 위 텍스트는 TEXT 가 아니라 TEXT_PATH 노드라 collectTextNodes 에서 이미 빠진다.

  const fills = node.fills
  if (fills === figma.mixed) {
    // 글자마다 색이 다른 것은 괜찮다 — SVG 가 색마다 <text> 를 따로 주고 run 이 그 색으로 그린다.
    // 세그먼트 하나라도 단색 하나가 아니면(그라데이션·겹친 칠·숨긴 칠) 원래대로 둔다
    const plain = node
      .getStyledTextSegments(['fills'])
      .every(
        (segment) =>
          segment.fills.length === 1 &&
          segment.fills[0].type === 'SOLID' &&
          segment.fills[0].visible !== false
      )
    if (!plain) return { ok: false, reason: { code: 'reject.mixedFill' } }
  } else {
    if (!Array.isArray(fills) || fills.length === 0)
      return { ok: false, reason: { code: 'reject.noFill' } }
    if (fills.some((paint) => paint.type !== 'SOLID' || paint.visible === false)) {
      return { ok: false, reason: { code: 'reject.nonSolidFill' } }
    }
  }

  const strokes = node.strokes
  if (Array.isArray(strokes) && strokes.length > 0) {
    return { ok: false, reason: { code: 'reject.stroked' } }
  }

  const effects = node.effects
  if (Array.isArray(effects) && effects.some((effect) => effect.visible !== false)) {
    return { ok: false, reason: { code: 'reject.effects' } }
  }

  // 밑줄·취소선은 글자와 함께 지워지고, UI 가 폰트의 밑줄·취소선 메트릭으로 다시 긋는다
  // (textLayer.drawDecorations). 기본 모양(실선, 위치·두께·색 자동)만 — 물결·점선이나 직접 정한
  // 위치·두께·색은 아직 못 따라 그리니 원래 모양(아웃라인)으로 둔다.
  const decoration = screenDecoration(node)
  if (decoration !== null) return { ok: false, reason: decoration }

  // 합성 상태 — 다시 그린 글자는 마스크·블렌드·조상의 불투명도·효과·클리핑을 받지 않는다.
  // 노드 자신의 불투명도는 SVG 에 실려 오므로 그대로 그린다(svgText 가 <g opacity> 까지 읽는다).
  if (node.isMask) return { ok: false, reason: { code: 'reject.mask' } }
  if (!isNormalBlend(node.blendMode)) return { ok: false, reason: { code: 'reject.blend' } }
  const composed = screenAncestors(node, root)
  if (composed !== null) return { ok: false, reason: composed }
  // 다시 그린 글자는 쪽 맨 위에 얹힌다 — 위에 칠해진 레이어가 가리던 글자(간판 뒷면의 거울 글자 등)가
  // 드러난다. 가려진 글자는 원래 자리·순서 그대로 두어야 한다
  if (isCovered(node, root)) return { ok: false, reason: { code: 'reject.covered' } }

  // 위첨자·아래첨자: Figma 는 폰트에 위첨자 글리프가 없는 글자를 축소·이동해 합성하고, 한 레이어에
  // 있는 글자와 없는 글자가 섞이면 전부 합성으로 통일한다. 우리는 OpenType sups/subs 를 켜서
  // 그릴 뿐이라 숫자는 폰트의 위첨자 글리프, 쉼표는 본문 크기 기준선으로 남았다(사용자 제보).
  // 그 규칙을 흉내 내기 전까지는 원래 모양(아웃라인)으로 둔다.
  //
  // 목록은 이제 우리가 그린다. 마커가 characters 에도 SVG 에도 없는 것은 그대로지만,
  // 자리를 실측해 공식을 세웠다(lib/listMarker). 어긋나면 그리는 쪽에서 물러선다.
  for (const segment of node.getStyledTextSegments(['openTypeFeatures'])) {
    const features = (segment.openTypeFeatures ?? {}) as Partial<Record<string, boolean>>
    if (features.SUPS === true || features.SUBS === true) {
      return { ok: false, reason: { code: 'reject.superscript' } }
    }
  }

  return { ok: true }
}

/**
 * 밑줄·취소선을 우리가 다시 그어도 되는가. Figma 의 기본값(실선·자동 위치·자동 두께·글자색)이면
 * 폰트의 post·OS/2 메트릭으로 같은 자리에 긋는다. 그 밖은 사유를 돌려준다.
 *
 * 잉크 건너뛰기(skip ink)는 따라 하지 않는다 — 밑줄이 디센더(g·p·y) 밑을 끊기지 않고 지나간다.
 * 모양이 아주 조금 다를 뿐 글자는 그대로라 아웃라인으로 남기는 것보다 낫다고 본다.
 */
function screenDecoration(node: TextNode): Reason | null {
  const segments = node.getStyledTextSegments([
    'textDecoration',
    'textDecorationStyle',
    'textDecorationOffset',
    'textDecorationThickness',
    'textDecorationColor'
  ])
  // 이 속성들이 없는 옛 API 응답에서는 undefined 다 — 없으면 기본값(자동)으로 본다
  for (const segment of segments) {
    if ((segment.textDecoration ?? 'NONE') === 'NONE') continue
    const style = segment.textDecorationStyle ?? 'SOLID'
    if (style !== 'SOLID') return { code: 'reject.decorated' }
    // 밑줄의 위치·두께는 Figma 가 정한 대로 따라 그린다(decorationOf). 취소선의 위치는 기준을 아직
    // 실측하지 않았다 — 직접 정했으면 원래대로
    const custom =
      (segment.textDecorationOffset?.unit ?? 'AUTO') !== 'AUTO' ||
      (segment.textDecorationThickness?.unit ?? 'AUTO') !== 'AUTO'
    if (custom && segment.textDecoration !== 'UNDERLINE') return { code: 'reject.decorated' }
    const color = segment.textDecorationColor?.value ?? 'AUTO'
    if (color !== 'AUTO' && (color.type !== 'SOLID' || color.visible === false))
      return { code: 'reject.decorated' }
  }
  return null
}

/**
 * 세그먼트의 밑줄 모양 중 Figma 기본(폰트 메트릭·글자색)과 다른 것. 실측(WCMA 사인 도면, Union):
 * 위치는 반올림한 기준선에서 선의 윗변까지, 두께와 함께 글자 크기의 % 또는 px 이다.
 * 14% → 9pt 글자에서 1.26pt 아래, 5% → 0.45pt.
 */
export function decorationOf(
  segment: Pick<
    StyledTextSegment,
    'fontSize' | 'textDecorationOffset' | 'textDecorationThickness' | 'textDecorationColor'
  >
): TextSegment['decoration'] {
  const em = (value: { unit: string; value?: number } | null | undefined): number | undefined => {
    if (value === null || value === undefined || value.value === undefined) return undefined
    if (value.unit === 'PERCENT') return value.value / 100
    if (value.unit === 'PIXELS')
      return segment.fontSize > 0 ? value.value / segment.fontSize : undefined
    return undefined
  }
  const offset = em(segment.textDecorationOffset as { unit: string; value?: number } | null)
  const thickness = em(segment.textDecorationThickness as { unit: string; value?: number } | null)
  const paint = segment.textDecorationColor?.value
  const color =
    paint !== undefined && paint !== 'AUTO' && paint.type === 'SOLID'
      ? { r: paint.color.r, g: paint.color.g, b: paint.color.b, a: paint.opacity ?? 1 }
      : undefined
  if (offset === undefined && thickness === undefined && color === undefined) return undefined
  return {
    ...(offset === undefined ? {} : { top: -offset }),
    ...(thickness === undefined ? {} : { thickness }),
    ...(color === undefined ? {} : { color })
  }
}

type Bounds = { x: number; y: number; width: number; height: number }

function overlaps(a: Bounds | null, b: Bounds | null): boolean {
  if (a === null || b === null) return false
  const slack = 0.5
  return (
    a.x < b.x + b.width - slack &&
    b.x < a.x + a.width - slack &&
    a.y < b.y + b.height - slack &&
    b.y < a.y + a.height - slack
  )
}

const CONTAINERS = new Set(['FRAME', 'GROUP', 'SECTION', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET'])

function paints(node: SceneNode): boolean {
  const visible = (list: unknown): boolean =>
    Array.isArray(list) &&
    list.some(
      (paint: Paint) =>
        paint.visible !== false && (paint.opacity === undefined || paint.opacity > 0)
    )
  return ('fills' in node && visible(node.fills)) || ('strokes' in node && visible(node.strokes))
}

/** 이 노드(또는 그 안의 무언가)가 box 위에 칠해지는가. 글자끼리 겹치는 것은 보지 않는다 */
function coversBox(node: SceneNode, box: Bounds): boolean {
  if (node.visible === false) return false
  if ('opacity' in node && node.opacity === 0) return false
  if (node.type === 'TEXT') return false
  if (!overlaps('absoluteRenderBounds' in node ? node.absoluteRenderBounds : null, box))
    return false
  if (!CONTAINERS.has(node.type)) return true
  if (paints(node)) return true
  return 'children' in node && node.children.some((child) => coversBox(child, box))
}

/**
 * 순서상 이 글자 위에(같은 부모의 뒤 형제, 조상들의 뒤 형제) 칠해지는 것이 글자 자리와 겹치는가.
 * 겹침은 상자로만 본다 — 가로지르는 치수선 같은 것도 걸리지만, 걸린 글자는 벡터로 바뀌어(설정에
 * 따라) 모양은 그대로이니 틀리는 것보다 낫다.
 */
export function isCovered(node: TextNode, root: BaseNode | undefined): boolean {
  const box = node.absoluteRenderBounds
  if (box === null) return false
  for (let current: BaseNode = node; current.parent !== null && current !== root;) {
    const parent: BaseNode & ChildrenMixin = current.parent
    if (parent.type === 'PAGE' || parent.type === 'DOCUMENT') break
    const siblings = parent.children
    for (
      let index = siblings.indexOf(current as SceneNode) + 1;
      index < siblings.length;
      index += 1
    )
      if (coversBox(siblings[index], box)) return true
    current = parent
  }
  return false
}

function isNormalBlend(mode: BlendMode): boolean {
  return mode === 'NORMAL' || mode === 'PASS_THROUGH'
}

type Box = { x: number; y: number; width: number; height: number }

function contains(outer: Box, inner: Box, tolerance = 0.5): boolean {
  return (
    inner.x >= outer.x - tolerance &&
    inner.y >= outer.y - tolerance &&
    inner.x + inner.width <= outer.x + outer.width + tolerance &&
    inner.y + inner.height <= outer.y + outer.height + tolerance
  )
}

/**
 * 내보내는 루트까지의 조상을 본다. 루트 밖(페이지·섹션)은 export 에 안 실리므로 보지 않는다 —
 * 프리플라이트(원본 프레임)와 export(클론)가 같은 답을 내려면 같은 경계에서 멈춰야 한다.
 *
 * - 불투명도·블렌드가 있는 컨테이너: 다시 그린 글자는 그 합성을 안 받는다
 * - 마스크 그룹: 마스크 위의 글자를 숨기면 마스크 모양이 바뀌고(글자가 마스크일 때), 글자가
 *   마스크에 잘리던 것도 통째로 나온다. 형제 중 마스크가 있으면 보수적으로 뺀다
 * - 레이어 흐림은 글자까지 흐리고, 채움 없는 부모의 그림자는 글자 모양으로 진다
 * - 클리핑 프레임 밖으로 나간 글자는 잘려 보였는데 다시 그리면 통째로 보인다
 */
function screenAncestors(node: TextNode, root: BaseNode | undefined): Reason | null {
  const box = node.absoluteRenderBounds ?? node.absoluteBoundingBox
  for (let parent = node.parent; parent !== null && parent !== root; parent = parent.parent) {
    if (parent.type === 'PAGE' || parent.type === 'DOCUMENT') break

    if ('opacity' in parent && parent.opacity < 1) return { code: 'reject.translucent' }
    if ('blendMode' in parent && !isNormalBlend(parent.blendMode)) return { code: 'reject.blend' }
    if (parent.children.some((child) => 'isMask' in child && child.isMask === true)) {
      return { code: 'reject.mask' }
    }
    if ('effects' in parent && Array.isArray(parent.effects)) {
      const filled =
        'fills' in parent &&
        Array.isArray(parent.fills) &&
        parent.fills.some((paint) => paint.visible !== false)
      const breaks = parent.effects.some(
        (effect) =>
          effect.visible !== false &&
          (effect.type === 'LAYER_BLUR' ||
            (!filled && (effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW')))
      )
      if (breaks) return { code: 'reject.parentEffects' }
    }
    if ('clipsContent' in parent && parent.clipsContent === true && box !== null) {
      const frame = parent.absoluteBoundingBox
      if (frame !== null && !contains(frame, box)) return { code: 'reject.clipped' }
    }
  }
  return null
}

/**
 * SVG·세그먼트·오프셋을 뽑는다. **fill 을 비우기 전에** 해야 한다 —
 * fill 이 비면 Figma 가 SVG 에도 텍스트를 안 넣는다.
 */
export async function extractText(
  node: TextNode,
  frame: SceneNode
): Promise<TextCandidate | { failed: Reason }> {
  // 축에 맞지 않는 글자는 똑바로 세운 사본에서 SVG·잉크 폭을 읽고, 원래 변환은 따로 넘긴다.
  // UI 가 그 변환을 cm 으로 걸고 사본 기준(왼쪽 위가 원점)으로 그린다 (ui/textLayer)
  const straight = isAxisAligned(node.absoluteTransform) ? null : straightCopy(node)
  const subject = straight ?? node
  try {
    const svg = await withTimeout(
      subject.exportAsync({
        format: 'SVG_STRING',
        svgOutlineText: false,
        useAbsoluteBounds: true
      }),
      SVG_TIMEOUT_MS,
      node.name
    )

    const box = subject.absoluteBoundingBox
    const frameBox = frame.absoluteBoundingBox
    if (box === null || frameBox === null) return { failed: { code: 'reject.noBounds' } }

    const segments = node
      .getStyledTextSegments([
        'fontName',
        'fontSize',
        'fills',
        'letterSpacing',
        'textDecoration',
        'textCase',
        'hyperlink',
        'openTypeFeatures',
        'listOptions',
        'indentation',
        'textDecorationOffset',
        'textDecorationThickness',
        'textDecorationColor'
      ])
      .map((segment): TextSegment => ({
        start: segment.start,
        end: segment.end,
        fontName: { family: segment.fontName.family, style: segment.fontName.style },
        fontSize: segment.fontSize,
        fills: segment.fills.map((paint) => ({
          r: paint.type === 'SOLID' ? paint.color.r : 0,
          g: paint.type === 'SOLID' ? paint.color.g : 0,
          b: paint.type === 'SOLID' ? paint.color.b : 0,
          a: paint.opacity ?? 1
        })),
        letterSpacing: {
          unit: segment.letterSpacing.unit,
          value: segment.letterSpacing.value
        },
        textDecoration: String(segment.textDecoration),
        ...(segment.textDecoration === 'NONE' || decorationOf(segment) === undefined
          ? {}
          : { decoration: decorationOf(segment) }),
        listType: segment.listOptions?.type ?? 'NONE',
        indentation: segment.indentation ?? 0,
        textCase: String(segment.textCase),
        // NODE 링크는 Figma 안의 다른 레이어로 간다 — PDF 안의 쪽 이동으로 잇는다 (lib/figmaLinks)
        hyperlink:
          segment.hyperlink !== null &&
          (segment.hyperlink.type === 'URL' || segment.hyperlink.type === 'NODE')
            ? { type: segment.hyperlink.type, value: segment.hyperlink.value ?? '' }
            : null,
        // Figma 는 'SS18' 처럼 대문자 — OpenType 태그는 소문자다. 실측: SUIT 의 "→" 는 ss18 을
        // 켜야 막대 있는 화살표고, 기본은 꺾쇠(〉)다. 기능을 잃으면 다른 글자가 나간다
        features: Object.fromEntries(
          Object.entries(segment.openTypeFeatures ?? {}).map(([tag, enabled]) => [
            tag.toLowerCase(),
            enabled === true
          ])
        )
      }))

    const fontRefs = segments.map((segment) => segment.fontName)

    // Figma 가 그린 잉크 폭 — UI 가 우리 폰트로 놓은 폭과 견줘 다른 판의 폰트를 잡는다
    const render = subject.absoluteRenderBounds
    const scale = transformScale(subject.absoluteTransform)
    const inkWidth =
      render === null || !(scale.x > 0) || !(render.width > 0) ? undefined : render.width / scale.x

    return {
      node,
      fontRefs,
      source: {
        nodeId: node.id,
        characters: node.characters,
        svg,
        offset:
          straight === null
            ? { x: box.x - frameBox.x, y: box.y - frameBox.y }
            : // 사본의 원점은 자기 왼쪽 위다 — SVG 의 상자와 노드의 좌표계가 일치한다
              {
                x: box.x - straight.absoluteTransform[0][2],
                y: box.y - straight.absoluteTransform[1][2]
              },
        segments,
        ...(inkWidth === undefined ? {} : { inkWidth }),
        ...(straight === null
          ? {}
          : { transform: frameTransform(node.absoluteTransform, frameBox) })
      }
    }
  } catch (error) {
    return {
      failed: {
        code: 'reason.raw',
        params: { message: error instanceof Error ? error.message : String(error) }
      }
    }
  } finally {
    if (straight !== null && !straight.removed) straight.remove()
  }
}

/**
 * 변환을 걷어 낸 사본. 같은 부모에 두면 부모의 회전을 다시 받으므로 페이지 직속으로 옮긴다.
 * 폭·높이·자동 크기·글자 스타일은 노드 자신의 것이라 그대로 따라온다. 내보내기가 죽어도
 * 남은 정리(removeLeftoverClones)가 지우도록 표식을 단다.
 */
function straightCopy(node: TextNode): TextNode {
  const copy = node.clone()
  figma.currentPage.appendChild(copy)
  copy.relativeTransform = [
    [1, 0, STRAIGHT_COPY_X],
    [0, 1, 0]
  ]
  markTemporary(copy)
  return copy
}

/**
 * 노드 좌표(u, v) → 프레임 좌표(아래로 +y). Figma 의 [[a, c, e], [b, d, f]] 를 [a, b, c, d, e, f] 로
 * 펴고 평행이동을 내보내는 프레임의 왼쪽 위 기준으로 옮긴다.
 */
export function frameTransform(
  transform: Transform,
  frameBox: { x: number; y: number }
): [number, number, number, number, number, number] {
  const [[a, c, e], [b, d, f]] = transform
  return [a, b, c, d, e - frameBox.x, f - frameBox.y]
}

/** 클론 안의 텍스트 노드를 모은다. */
export function collectTextNodes(root: SceneNode): TextNode[] {
  const out: TextNode[] = []

  const visit = (node: SceneNode): void => {
    if (node.visible === false) return
    // 불리언 연산(합치기·빼기) 안의 글자는 글자가 아니라 도형의 재료다 — Figma 는 연산 결과를
    // 한 도형으로 그리고 Type 3 를 쓰지 않는다. 숨기면 빼던 구멍이 메워지고(명판의 음각 글자),
    // 다시 그리면 재료의 색이 도형 위에 얹힌다. 건드리지 않는다
    if (node.type === 'BOOLEAN_OPERATION') return
    if (node.type === 'TEXT') out.push(node)
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }

  visit(root)
  return out
}

/**
 * 오토레이아웃을 꺼서 자식들을 지금 자리에 굳힌다.
 *
 * HUG 로 잡힌 프레임은 레이아웃을 끄는 순간 크기가 변하므로 먼저 FIXED 로 바꾼다.
 * 클론에서만 부르므로 원본 문서는 그대로다.
 */
/**
 * 클론 안의 인스턴스를 전부 떼어 낸다(detach).
 *
 * 인스턴스는 레이아웃 속성을 못 바꾼다 — 그래서 freezeLayout 이 안 먹고, 그 안의 텍스트를
 * 숨기면 허그 높이가 줄어 형제가 당겨진다. 실측: 이력서의 "섹션 타이틀" 인스턴스(세로
 * 오토레이아웃·허그)에서 제목을 숨기자 아래 구분선이 제목 높이만큼(14pt) 올라와 제목 위에
 * 얹혔다. 떼어 낸 프레임은 보기에 똑같고 클론은 버리는 것이라 잃을 게 없다.
 * 바깥 인스턴스부터 떼야 안쪽이 떼어진다 — 안쪽 것은 던지므로 한 바퀴 더 돈다.
 * 루트 자체가 인스턴스면 새 프레임을 돌려주니 호출자가 바꿔 잡아야 한다.
 */
export function detachInstances(root: SceneNode): SceneNode {
  let top: SceneNode = root
  if (top.type === 'INSTANCE') top = top.detachInstance()

  for (let round = 0; round < 20; round += 1) {
    if (!('findAll' in top)) return top
    const instances = top.findAll((node) => node.type === 'INSTANCE') as InstanceNode[]
    if (instances.length === 0) return top
    let detached = 0
    for (const instance of instances) {
      try {
        if (!instance.removed) {
          instance.detachInstance()
          detached += 1
        }
      } catch {
        // 안쪽 인스턴스는 바깥을 뗀 뒤에야 떼어진다 — 다음 바퀴
      }
    }
    if (detached === 0) return top // 하나도 못 뗐으면 돌아 봐야 같다
  }
  return top
}

/**
 * 텍스트를 숨겨도 형제가 움직이지 않게 — 가장 가까운 오토레이아웃 조상을 굳힌다.
 *
 * 직계 부모만 보면 안 된다. 텍스트가 **그룹** 안에 있으면 그룹은 자식 크기를 따라가므로
 * 숨기는 순간 그룹이 줄고, 그 위의 오토레이아웃이 아래 형제(구분선 등)를 끌어올린다.
 * 실측: 이력서의 "Career History" 제목이 그룹 안에 있어 구분선이 14pt 위로 올라왔다.
 * 오토레이아웃이 아닌 프레임을 만나면 그 안은 절대 좌표라 더 볼 것 없다.
 */
export function freezeLayout(parent: BaseNode | null): void {
  let current: BaseNode | null = parent
  while (current !== null && current.type !== 'PAGE' && current.type !== 'DOCUMENT') {
    if ('layoutMode' in current) {
      freezeFrame(current as FrameNode)
      return
    }
    current = current.parent
  }
}

function freezeFrame(frame: FrameNode): void {
  if (frame.layoutMode === 'NONE') return

  try {
    if (frame.layoutSizingHorizontal === 'HUG') frame.layoutSizingHorizontal = 'FIXED'
    if (frame.layoutSizingVertical === 'HUG') frame.layoutSizingVertical = 'FIXED'
  } catch {
    // 오토레이아웃 자식이 아니면 이 속성을 못 쓴다 — 크기는 어차피 안 변한다
  }

  frame.layoutMode = 'NONE'
}

/**
 * 글리프를 export 에서 완전히 빼낸다.
 *
 * ⚠ fill 만 비우면 안 된다. 눈에는 안 보이지만 텍스트 그리기 연산과 Type 3 폰트·
 * ToUnicode 가 PDF 에 그대로 남는다. 화면은 멀쩡한데 추출기만 유령 텍스트를 읽어서,
 * 우리가 다시 그린 문장과 겹쳐 나온다 — 실측한 이력서에서 추출 텍스트의 5% 가 유령이었고
 * 이름이 "장장원석A AI" 로 깨졌다. ATS 가 가장 먼저 읽는 자리다.
 *
 * visible = false 면 export 에서 아예 빠지지만 오토레이아웃 형제가 재배치된다 (C6).
 * 그래서 부모의 레이아웃을 먼저 굳힌 뒤 숨긴다.
 */
export function hideTextGlyphs(node: TextNode): void {
  freezeLayout(node.parent)
  node.visible = false
}

/**
 * Figma 가 그림 글자(이모지)로 그리는 문자. ♿ 같은 것 — 폰트에 없어서 Figma 가 색 이모지로 채운다.
 * flatten 은 이런 글자가 섞인 레이어에서 그 줄의 다른 글자까지 EMOJI 칠로 바꿔 지운다(실측: WCMA
 * 주차 표지 "f03.09–10 ♿ EV Charging" 에서 코드와 ♿ 가 사라졌다)
 */
const PICTOGRAPH =
  /[\u2600-\u27BF\u2B00-\u2BFF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF]/

/**
 * 글자를 같은 모양의 도형으로 바꾼다 (Settings.flattenLeftovers). 보통은 벡터로 — 채움·획·효과·
 * 블렌드는 벡터가 이어받는다. 이모지가 섞였으면 Figma 가 그린 그대로의 4배 그림으로 바꾼다.
 * 오토레이아웃 형제가 움직이지 않게 부모를 먼저 굳힌다. 실패하면 false — Type 3 그대로 남는다.
 */
export async function flattenText(node: TextNode): Promise<boolean> {
  try {
    const parent = node.parent
    // 글자 자체가 마스크면 도형이 마스크를 이어받는지 장담할 수 없다 — 가려지던 것이 드러나면 안 된다
    if (parent === null || node.isMask) return false
    if (PICTOGRAPH.test(node.characters)) return await rasterizeText(node)
    freezeLayout(parent)
    const vector = figma.flatten(
      [node],
      parent as BaseNode & ChildrenMixin,
      parent.children.indexOf(node)
    )
    await clearUnexportablePaints(vector)
    return true
  } catch {
    return false
  }
}

/** flatten 이 남긴 내보낼 수 없는 칠(EMOJI 등)이 있는 영역은 벡터의 칠을 따르게 한다 */
async function clearUnexportablePaints(vector: VectorNode): Promise<void> {
  const network = vector.vectorNetwork
  const known = new Set([
    'SOLID',
    'GRADIENT_LINEAR',
    'GRADIENT_RADIAL',
    'GRADIENT_ANGULAR',
    'GRADIENT_DIAMOND',
    'IMAGE'
  ])
  const regions = network.regions ?? []
  const broken = regions.some((region) => region.fills?.some((paint) => !known.has(paint.type)))
  if (!broken) return
  const solid = (Array.isArray(vector.fills) ? vector.fills : []).filter((paint) =>
    known.has(paint.type)
  )
  await vector.setVectorNetworkAsync({
    ...network,
    regions: regions.map((region) =>
      region.fills?.some((paint) => !known.has(paint.type)) ? { ...region, fills: solid } : region
    )
  })
}

/**
 * Figma 가 그린 그대로를 4배 PNG 로 찍어 같은 자리에 놓고 글자는 숨긴다. 축에 맞는 글자만 —
 * 돌아간 글자는 그림의 자리를 맞추기 어렵다.
 */
async function rasterizeText(node: TextNode): Promise<boolean> {
  const bounds = node.absoluteRenderBounds
  const parent = node.parent
  if (bounds === null || parent === null || !isAxisAligned(node.absoluteTransform)) return false
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 4 } })
  freezeLayout(parent)
  const image = figma.createImage(bytes)
  // 만든 직후에는 그림이 아직 안 읽혔을 수 있다 — 그대로 내보내면 Figma 의 분홍 자리표시가 찍힌다
  // (실측: WCMA 주차 표지 둘 중 하나가 분홍 상자로 나왔다). 크기를 읽으면 다 읽힌 뒤에 돌아온다
  await image.getSizeAsync()
  const picture = figma.createRectangle()
  picture.name = node.name
  picture.resize(Math.max(bounds.width, 0.01), Math.max(bounds.height, 0.01))
  picture.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }]
  ;(parent as BaseNode & ChildrenMixin).insertChild(parent.children.indexOf(node) + 1, picture)
  // 부모가 그룹이면 x·y 의 기준이 부모가 아니다 — 놓은 뒤 절대 위치의 차이만큼 옮긴다
  const placed = picture.absoluteBoundingBox
  if (placed !== null) {
    picture.x += bounds.x - placed.x
    picture.y += bounds.y - placed.y
  }
  node.visible = false
  return true
}
