import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { JSDOM } from 'jsdom'
import { PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib'
import { describe, expect, it, vi } from 'vitest'

import { NODE_LINK_SCHEME } from '../src/lib/figmaLinks'
import { TextRunSource, TextSegment } from '../src/lib/types'
import { FontProbe } from '../src/ui/fontkitAdapter'
import { decorationOf } from '../src/main/text'
import { decorationMetrics, drawTextLayer, FontProvider } from '../src/ui/textLayer'

const parseXml = (svg: string): Document =>
  new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document

const SVG = `<svg xmlns="http://www.w3.org/2000/svg">
<text font-family="Test" font-size="12" font-weight="400"><tspan x="0" y="10">See Appendix</tspan></text>
</svg>`

function segment(
  start: number,
  end: number,
  options: { decoration?: string; link?: TextSegment['hyperlink'] } = {}
): TextSegment {
  return {
    start,
    end,
    fontName: { family: 'Test', style: 'Regular' },
    fontSize: 12,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }],
    letterSpacing: { unit: 'PIXELS', value: 0 },
    textDecoration: options.decoration ?? 'NONE',
    textCase: 'ORIGINAL',
    features: {},
    hyperlink: options.link ?? null,
    listType: 'NONE',
    indentation: 0
  }
}

/** 메트릭이 있는 폰트 흉내 — 밑줄 윗변 -0.1em·두께 0.05em, 취소선 윗변 0.3em·두께 0.05em */
const probe = {
  layout: () => ({ glyphs: [], positions: [] }),
  unitsPerEm: 1000,
  underlinePosition: -100,
  underlineThickness: 50,
  'OS/2': { yStrikeoutPosition: 300, yStrikeoutSize: 50 }
} as unknown as FontProbe

async function setup(): Promise<{ page: import('pdf-lib').PDFPage; provider: FontProvider }> {
  const document = await PDFDocument.create()
  const page = document.addPage([595, 842])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const provider: FontProvider = {
    get: async () => ({ ok: true, font, probe, covers: () => [] })
  }
  return { page, provider }
}

function source(segments: TextSegment[]): TextRunSource {
  return { nodeId: '1:1', characters: 'See Appendix', svg: SVG, offset: { x: 0, y: 0 }, segments }
}

/** 밀어 넣은 연산자 중 사각형(m l l l h f)의 아랫변·윗변 y */
function filledBars(calls: unknown[][]): Array<{ bottom: number; top: number }> {
  const ops = calls.flat().map((op) => String(op))
  const bars: Array<{ bottom: number; top: number }> = []
  for (let i = 0; i + 5 < ops.length; i += 1) {
    if (ops[i].endsWith(' m') && ops[i + 4] === 'h' && ops[i + 5] === 'f') {
      const bottom = Number(ops[i].split(' ')[1])
      const top = Number(ops[i + 2].split(' ')[1])
      bars.push({ bottom, top })
    }
  }
  return bars
}

describe('decorationMetrics', () => {
  it('폰트의 post·OS/2 값을 em 단위로', () => {
    expect(decorationMetrics(probe)).toEqual({
      underline: { top: -0.1, thickness: 0.05 },
      strikeout: { top: 0.3, thickness: 0.05 }
    })
  })

  it('값이 없는 폰트는 흔한 비율로 대신한다', () => {
    const bare = {
      unitsPerEm: 2048,
      underlinePosition: 0,
      underlineThickness: 0
    } as unknown as FontProbe
    expect(decorationMetrics(bare)).toEqual({
      underline: { top: -0.1, thickness: 0.05 },
      strikeout: { top: 0.3, thickness: 0.05 }
    })
  })
})

describe('drawTextLayer — 밑줄·취소선', () => {
  it('밑줄이 걸린 글자 아래에만, 폰트 메트릭 자리에 긋는다', async () => {
    const { page, provider } = await setup()
    const pushed = vi.spyOn(page, 'pushOperators')
    await drawTextLayer(
      page,
      [source([segment(0, 4), segment(4, 12, { decoration: 'UNDERLINE' })])],
      provider,
      parseXml
    )
    const bars = filledBars(pushed.mock.calls)
    expect(bars).toHaveLength(1)
    // 기준선 842-10 = 832, 12pt → 윗변 832-1.2, 두께 0.6
    expect(bars[0].top).toBeCloseTo(830.8, 5)
    expect(bars[0].bottom).toBeCloseTo(830.2, 5)
  })

  it('취소선은 x-height 쯤, 장식이 없으면 아무것도 긋지 않는다', async () => {
    const { page, provider } = await setup()
    const pushed = vi.spyOn(page, 'pushOperators')
    await drawTextLayer(
      page,
      [source([segment(0, 12, { decoration: 'STRIKETHROUGH' })])],
      provider,
      parseXml
    )
    const bars = filledBars(pushed.mock.calls)
    expect(bars).toHaveLength(1)
    expect(bars[0].top).toBeCloseTo(832 + 3.6, 5)

    const plain = await setup()
    const plainPushed = vi.spyOn(plain.page, 'pushOperators')
    await drawTextLayer(plain.page, [source([segment(0, 12)])], plain.provider, parseXml)
    expect(filledBars(plainPushed.mock.calls)).toEqual([])
  })
})

describe('drawTextLayer — 직접 정한 밑줄', () => {
  it('Figma 가 정한 위치·두께로 긋는다 — 반올림한 기준선에서 윗변까지 글자 크기의 %', async () => {
    const { page, provider } = await setup()
    const pushed = vi.spyOn(page, 'pushOperators')
    const custom = {
      ...segment(0, 12, { decoration: 'UNDERLINE' }),
      decoration: { top: -0.14, thickness: 0.05, color: { r: 1, g: 0, b: 0, a: 1 } }
    }
    await drawTextLayer(page, [source([custom])], provider, parseXml)
    const bars = filledBars(pushed.mock.calls)
    expect(bars).toHaveLength(1)
    // 기준선 832, 12pt → 윗변 832 − 1.68, 두께 0.6
    expect(bars[0].top).toBeCloseTo(830.32, 5)
    expect(bars[0].bottom).toBeCloseTo(829.72, 5)
    const ops = pushed.mock.calls.flat().map(String)
    expect(ops).toContain('1 0 0 rg')
  })
})

describe('decorationOf', () => {
  it('% 와 px 을 em 으로, 선 색은 불투명도와 함께', () => {
    expect(
      decorationOf({
        fontSize: 14,
        textDecorationOffset: { unit: 'PERCENT', value: 12 },
        textDecorationThickness: { unit: 'PIXELS', value: 1 },
        textDecorationColor: { value: 'AUTO' }
      } as never)
    ).toEqual({ top: -0.12, thickness: 1 / 14 })
    expect(
      decorationOf({
        fontSize: 9,
        textDecorationOffset: { unit: 'AUTO' },
        textDecorationThickness: { unit: 'AUTO' },
        textDecorationColor: { value: 'AUTO' }
      } as never)
    ).toBeUndefined()
  })
})

describe('drawTextLayer — 레이어 링크', () => {
  it('NODE 링크는 자리표시 URL 의 링크 주석이 된다 — 머지 뒤 쪽 이동으로 바뀐다', async () => {
    const { page, provider } = await setup()
    await drawTextLayer(
      page,
      [source([segment(0, 4), segment(4, 12, { link: { type: 'NODE', value: '4309:8222' } })])],
      provider,
      parseXml
    )
    const annots = page.node.Annots()
    expect(annots?.size()).toBe(1)
    const annot = page.doc.context.lookup(annots?.get(0), PDFDict)
    const action = annot.lookup(PDFName.of('A'), PDFDict)
    const uri = action.lookup(PDFName.of('URI'))
    expect(uri instanceof PDFString ? uri.decodeText() : '').toBe(NODE_LINK_SCHEME + '4309:8222')
  })
})

describe('drawTextLayer — 글자가 흩어진 SVG (WCMA Message Schedule)', () => {
  // Figma 는 이 레이어를 한 글자씩 여러 <text> 로 흩어 썼다(실제 내보내기 그대로). 원문 위치 찾기는
  // 흩어진 "e"·"r" 을 밑줄 친 "here" 자리에 맞춰 엉뚱한 글자에 밑줄을 그었다 — SVG 의
  // text-decoration·<a> 를 믿는다
  const characters =
    'Message Schedule Draft\n\nMessages may be revised. Source of truth is the online Coda spreadsheet linked here.'
  const svg = readFileSync(join(__dirname, 'fixtures', 'scattered-underline.svg'), 'utf8')

  it('밑줄과 링크는 SVG 가 밑줄이라고 한 "here" 에만', async () => {
    const { page, provider } = await setup()
    const pushed = vi.spyOn(page, 'pushOperators')
    const link = {
      type: 'URL' as const,
      value: 'https://coda.io/d/_dV4nXIXH9Zj/Message-Schedule_suCmSuOH'
    }
    const segments = [
      segment(0, 103),
      segment(103, 107, { decoration: 'UNDERLINE', link }),
      segment(107, 108)
    ]
    await drawTextLayer(
      page,
      [{ nodeId: '1:1', characters, svg, offset: { x: 0, y: 0 }, segments }],
      provider,
      parseXml
    )
    const ops = pushed.mock.calls.flat().map(String)
    const starts = ops.filter((op) => op.endsWith(' m')).map((op) => Number(op.split(' ')[0]))
    expect(starts).toEqual([285.352]) // 밑줄 하나, "here" 의 x 에서
    expect(page.node.Annots()?.size()).toBe(1)
  })
})
