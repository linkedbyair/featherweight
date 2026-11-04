import { JSDOM } from 'jsdom'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'

import { TextRunSource, TextSegment } from '../src/lib/types'
import { frameTransform, isAxisAligned } from '../src/main/text'
import { FontProbe } from '../src/ui/fontkitAdapter'
import { drawTextLayer, FontProvider, placementOf } from '../src/ui/textLayer'

const parseXml = (svg: string): Document =>
  new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document

const SVG = `<svg xmlns="http://www.w3.org/2000/svg">
<text font-family="Test" font-size="12" font-weight="400"><tspan x="0" y="10">Main Entrance</tspan></text>
</svg>`

const segment: TextSegment = {
  start: 0,
  end: 13,
  fontName: { family: 'Test', style: 'Regular' },
  fontSize: 12,
  fills: [{ r: 0, g: 0, b: 0, a: 1 }],
  letterSpacing: { unit: 'PIXELS', value: 0 },
  textDecoration: 'NONE',
  textCase: 'ORIGINAL',
  features: {},
  hyperlink: { type: 'URL', value: 'https://example.com' },
  listType: 'NONE',
  indentation: 0
}

const probe = {
  layout: () => ({ glyphs: [], positions: [] }),
  unitsPerEm: 1000,
  underlinePosition: -100,
  underlineThickness: 50
} as unknown as FontProbe

/** Figma 가 노드 좌표 (u, v) 를 프레임의 어디에 놓는지 — 아래로 +y */
function figmaPoint(t: number[], u: number, v: number): [number, number] {
  const [a, b, c, d, e, f] = t
  return [a * u + c * v + e, b * u + d * v + f]
}

describe('frameTransform', () => {
  it('Figma 의 [[a, c, e], [b, d, f]] 를 펴고 프레임 왼쪽 위 기준으로 옮긴다', () => {
    const transform: Transform = [
      [0.8, 0.1, 1100],
      [-0.5, 1, 2050]
    ]
    expect(frameTransform(transform, { x: 1000, y: 2000 })).toEqual([0.8, -0.5, 0.1, 1, 100, 50])
  })

  it('회전·뒤집기가 없으면 예전처럼 평행이동으로 다룬다', () => {
    expect(
      isAxisAligned([
        [1, 0, 5],
        [0, 1, 5]
      ])
    ).toBe(true)
    expect(
      isAxisAligned([
        [-1, 0, 5],
        [0, 1, 5]
      ])
    ).toBe(false)
    expect(
      isAxisAligned([
        [0, -1, 5],
        [1, 0, 5]
      ])
    ).toBe(false)
  })
})

describe('placementOf', () => {
  const H = 842
  const cases: Record<string, number[]> = {
    rotated90: [0, -1, 1, 0, 40, 300],
    sheared: [0.8320503, -0.5547002, 0, 1, 10, 50],
    mirrored: [-1, 0, 0, 1, 500, 20],
    rotated180: [-1, 0, 0, -1, 400, 400]
  }

  for (const [name, t] of Object.entries(cases)) {
    it(`${name}: 그린 자리가 Figma 의 자리와 같다`, () => {
      const placed = placementOf(
        {
          nodeId: '1:1',
          characters: '',
          svg: '',
          offset: { x: 0, y: 0 },
          segments: [],
          transform: t as [number, number, number, number, number, number]
        },
        H
      )
      expect(placed.height).toBe(0)
      for (const [u, v] of [
        [0, 0],
        [120, 0],
        [0, 14],
        [37, 9]
      ]) {
        // drawRun 은 노드 좌표계에서 (u, height − v) = (u, −v) 에 그린다
        const [x, y] = placed.toPage(u, placed.height - v)
        const [fx, fy] = figmaPoint(t, u, v)
        expect(x).toBeCloseTo(fx, 6)
        expect(y).toBeCloseTo(H - fy, 6)
      }
    })
  }

  it('변환이 없으면 쪽 좌표 그대로 — cm 을 안 건다', () => {
    const placed = placementOf(
      { nodeId: '1:1', characters: '', svg: '', offset: { x: 3, y: 4 }, segments: [] },
      H
    )
    expect(placed.matrix).toBeNull()
    expect(placed.height).toBe(H)
    expect(placed.offset).toEqual({ x: 3, y: 4 })
  })
})

describe('drawTextLayer — 변환이 있는 텍스트', () => {
  async function draw(transform?: [number, number, number, number, number, number]) {
    const document = await PDFDocument.create()
    const page = document.addPage([595, 842])
    const font = await document.embedFont(StandardFonts.Helvetica)
    const provider: FontProvider = {
      get: async () => ({ ok: true, font, probe, covers: () => [] })
    }
    const pushed = vi.spyOn(page, 'pushOperators')
    const source: TextRunSource = {
      nodeId: '1:1',
      characters: 'Main Entrance',
      svg: SVG,
      offset: { x: 0, y: 0 },
      segments: [segment],
      ...(transform === undefined ? {} : { transform })
    }
    const result = await drawTextLayer(page, [source], provider, parseXml)
    const ops = pushed.mock.calls.flat().map((op) => String(op))
    return { page, result, ops }
  }

  it('q · cm … Q 로 감싸고, 글자는 노드 좌표에 놓는다', async () => {
    const { result, ops } = await draw([0.8320503, -0.5547002, 0, 1, 10, 50])
    expect(result.drawn).toBe(1)
    expect(ops[0]).toBe('q')
    expect(ops[1]).toMatch(/^0\.832\d* 0\.554\d* -?0 1 10 792 cm$/)
    expect(ops[ops.length - 1]).toBe('Q')
    // 기준선 v = 10 → 노드 좌표계 y = −10
    expect(ops.some((op) => op === '1 0 0 1 0 -10 Tm')).toBe(true)
  })

  it('기울어진 링크는 덮는 상자와 실제 모양(QuadPoints)을 함께 단다', async () => {
    const { page } = await draw([0, -1, 1, 0, 40, 300])
    const annot = page.doc.context.lookup(page.node.Annots()?.get(0), PDFDict)
    const rect = annot
      .lookup(PDFName.of('Rect'), PDFArray)
      .asArray()
      .map((n) => (n as PDFNumber).asNumber())
    const quad = annot.lookup(PDFName.of('QuadPoints'), PDFArray)
    expect(quad.size()).toBe(8)
    // 90° 돌린 글자: 링크 상자는 세로로 길다
    expect(rect[3] - rect[1]).toBeGreaterThan(rect[2] - rect[0])
  })

  it('변환이 없으면 cm 도 QuadPoints 도 없다', async () => {
    const { page, ops } = await draw()
    expect(ops.some((op) => op.endsWith(' cm'))).toBe(false)
    const annot = page.doc.context.lookup(page.node.Annots()?.get(0), PDFDict)
    expect(annot.get(PDFName.of('QuadPoints'))).toBeUndefined()
  })
})
