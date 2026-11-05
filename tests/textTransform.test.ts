import { JSDOM } from 'jsdom'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'

import { TextRunSource, TextSegment } from '../src/lib/types'
import {
  collectTextNodes,
  flattenText,
  frameTransform,
  isAxisAligned,
  isCovered
} from '../src/main/text'
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

describe('drawTextLayer — 벡터로 바꾼 글자 위의 보이지 않는 글자', () => {
  it('렌더 모드 3 으로 그리고, 그린 수에도 리포트에도 안 넣는다', async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([595, 842])
    const font = await document.embedFont(StandardFonts.Helvetica)
    const provider: FontProvider = {
      get: async () => ({ ok: true, font, probe, covers: () => [] })
    }
    const pushed = vi.spyOn(page, 'pushOperators')
    const result = await drawTextLayer(
      page,
      [
        {
          nodeId: '1:1',
          characters: 'Main Entrance',
          svg: SVG,
          offset: { x: 0, y: 0 },
          segments: [{ ...segment, textDecoration: 'UNDERLINE' }],
          invisible: true
        }
      ],
      provider,
      parseXml
    )
    const ops = pushed.mock.calls.flat().map(String)
    expect(ops).toContain('3 Tr')
    expect(ops.some((op) => op === 'f')).toBe(false) // 밑줄은 벡터가 이미 그렸다
    expect(result).toEqual({ drawn: 0, fallbacks: [], substitutions: [] })
    // 링크는 단다 — 벡터에는 링크가 없다
    expect(page.node.Annots()?.size()).toBe(1)
  })

  it('폰트를 못 구하면 조용히 건너뛴다', async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([595, 842])
    const provider: FontProvider = {
      get: async () => ({ ok: false, reason: { code: 'font.missing' } }) as never
    }
    const result = await drawTextLayer(
      page,
      [
        {
          nodeId: '1:1',
          characters: 'Main Entrance',
          svg: SVG,
          offset: { x: 0, y: 0 },
          segments: [segment],
          invisible: true
        }
      ],
      provider,
      parseXml
    )
    expect(result).toEqual({ drawn: 0, fallbacks: [], substitutions: [] })
  })
})

describe('flattenText', () => {
  function setup(options: { isMask?: boolean; characters?: string } = {}) {
    const vector = {
      vectorNetwork: {
        vertices: [],
        segments: [],
        regions: [{ loops: [[0]], fills: [{ type: 'SOLID' }] }]
      },
      fills: [{ type: 'SOLID' }],
      setVectorNetworkAsync: vi.fn(async () => undefined)
    }
    const flatten = vi.fn(() => vector)
    const page = { type: 'PAGE', parent: null }
    const parent = { type: 'GROUP', parent: page, children: [] as unknown[] }
    const node = {
      type: 'TEXT',
      parent,
      isMask: options.isMask ?? false,
      characters: options.characters ?? 'Area Name'
    }
    parent.children.push({ id: 'sibling' }, node)
    Object.assign(globalThis, { figma: { flatten } })
    return { flatten, parent, vector, node: node as unknown as TextNode }
  }

  it('같은 부모의 같은 자리에서 벡터로 바꾼다', async () => {
    const { flatten, parent, node, vector } = setup()
    expect(await flattenText(node)).toEqual({ ok: true })
    expect(flatten).toHaveBeenCalledWith([node], parent, 1)
    expect(vector.setVectorNetworkAsync).not.toHaveBeenCalled()
  })

  it('flatten 이 남긴 EMOJI 칠 영역은 벡터의 칠로 되돌린다 — 글자가 사라지지 않게', async () => {
    const { node, vector } = setup()
    vector.vectorNetwork.regions = [
      { loops: [[0]], fills: [{ type: 'EMOJI' }] },
      { loops: [[1]], fills: [{ type: 'SOLID' }] }
    ]
    await flattenText(node)
    expect(vector.setVectorNetworkAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        regions: [
          { loops: [[0]], fills: [{ type: 'SOLID' }] },
          { loops: [[1]], fills: [{ type: 'SOLID' }] }
        ]
      })
    )
  })

  it('이모지(♿)가 섞인 글자는 flatten 하지 않고 Figma 가 그린 그림을 돌려준다', async () => {
    const { flatten, node } = setup({ characters: 'f03.09–10 ♿ EV Charging' })
    const png = new Uint8Array([1, 2, 3])
    Object.assign(node, {
      visible: true,
      absoluteRenderBounds: { x: 130, y: 260, width: 114, height: 28 },
      absoluteTransform: [
        [1, 0, 130],
        [0, 1, 260]
      ],
      exportAsync: vi.fn(async () => png)
    })
    const frame = { absoluteBoundingBox: { x: 100, y: 200, width: 1920, height: 1248 } }
    const result = await flattenText(node, frame as unknown as SceneNode)
    expect(flatten).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: true, picture: { x: 30, y: 60, width: 114, height: 28, png } })
    expect(node.visible).toBe(false)
  })

  it('위에 덮인 이모지 라벨은 그림으로 맨 위에 얹지 않는다 — 원래대로 둔다', async () => {
    const { node } = setup({ characters: '♿' })
    const frame = { absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 } }
    expect(await flattenText(node, frame as unknown as SceneNode, false)).toEqual({ ok: false })
  })

  it('글자 자체가 마스크면 건드리지 않는다', async () => {
    const { flatten, node } = setup({ isMask: true })
    expect(await flattenText(node)).toEqual({ ok: false })
    expect(flatten).not.toHaveBeenCalled()
  })

  it('Figma 가 거절하면 false — 원래 글자 그대로 남는다', async () => {
    const { node } = setup()
    Object.assign(globalThis, {
      figma: {
        flatten: () => {
          throw new Error('nope')
        }
      }
    })
    expect(await flattenText(node)).toEqual({ ok: false })
  })
})

describe('isCovered', () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })
  function scene(above: Record<string, unknown>) {
    const page = { type: 'PAGE', parent: null, children: [] as unknown[] }
    const frame = { type: 'FRAME', parent: page, children: [] as unknown[] }
    const text = {
      type: 'TEXT',
      parent: frame,
      visible: true,
      absoluteRenderBounds: box(10, 10, 100, 20)
    }
    frame.children.push(text, { parent: frame, visible: true, ...above })
    return { text: text as unknown as TextNode, frame: frame as unknown as BaseNode }
  }

  it('위에 칠해진 판이 글자 자리와 겹치면 가려진 것이다 — 간판 뒷면의 거울 글자', () => {
    const { text, frame } = scene({
      type: 'RECTANGLE',
      absoluteRenderBounds: box(0, 0, 200, 50),
      fills: [{ type: 'SOLID' }]
    })
    expect(isCovered(text, frame)).toBe(true)
  })

  it('겹치지 않거나, 칠 없는 그룹 안이 비었거나, 위의 것이 글자면 아니다', () => {
    expect(
      isCovered(
        scene({ type: 'RECTANGLE', absoluteRenderBounds: box(300, 300, 10, 10), fills: [] }).text,
        undefined
      )
    ).toBe(false)
    const empty = scene({
      type: 'GROUP',
      absoluteRenderBounds: box(0, 0, 200, 50),
      children: [{ type: 'RECTANGLE', visible: true, absoluteRenderBounds: box(150, 40, 10, 5) }]
    })
    expect(isCovered(empty.text, empty.frame)).toBe(false)
    const text = scene({ type: 'TEXT', absoluteRenderBounds: box(0, 0, 200, 50) })
    expect(isCovered(text.text, text.frame)).toBe(false)
  })
})

describe('collectTextNodes — 불리언 연산 안의 글자', () => {
  it('합치기·빼기의 재료인 글자는 모으지 않는다 — 명판의 음각 글자가 메워지지 않게', () => {
    const text = (name: string) => ({ type: 'TEXT', visible: true, name })
    const root = {
      type: 'FRAME',
      visible: true,
      children: [
        text('label'),
        {
          type: 'BOOLEAN_OPERATION',
          visible: true,
          children: [{ type: 'RECTANGLE', visible: true }, text('cutout')]
        },
        { type: 'GROUP', visible: true, children: [text('caption')] }
      ]
    } as unknown as SceneNode
    expect(collectTextNodes(root).map((node) => node.name)).toEqual(['label', 'caption'])
  })
})

describe('drawPictures', () => {
  it('그림으로 바꾼 라벨을 프레임 기준 자리에 얹고, 같은 그림은 한 번만 넣는다', async () => {
    const { PDFDocument: Doc } = await import('pdf-lib')
    const { drawPictures } = await import('../src/ui/pdf')
    // 1×1 투명 PNG
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
      ),
      (c) => c.charCodeAt(0)
    )
    const doc = await Doc.create()
    const first = doc.addPage([1920, 1248])
    const second = doc.addPage([1920, 1248])
    const drawn = vi.spyOn(first, 'drawImage')
    const picture = { x: 30, y: 60, width: 114, height: 28, png }
    await drawPictures(doc, first, [picture])
    await drawPictures(doc, second, [picture])
    expect(drawn).toHaveBeenCalledWith(expect.anything(), {
      x: 30,
      y: 1248 - 60 - 28,
      width: 114,
      height: 28
    })
    const saved = await Doc.load(await doc.save())
    const images = saved.context
      .enumerateIndirectObjects()
      .filter(([, object]) => /\/Subtype \/Image/.test(object.toString().slice(0, 400)))
    // 그림 하나(+ 투명도 마스크 하나) — 쪽이 둘이어도 다시 넣지 않는다
    expect(images.length).toBeLessThanOrEqual(2)
    expect(
      images.filter(([, object]) =>
        /\/ColorSpace \/DeviceRGB/.test(object.toString().slice(0, 400))
      )
    ).toHaveLength(1)
  })
})
