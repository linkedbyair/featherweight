import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib'
import { describe, expect, it } from 'vitest'

import {
  fileKeyFromLink,
  linkUrlOf,
  NODE_LINK_SCHEME,
  nodeIdFromLink,
  normalizeNodeId
} from '../src/lib/figmaLinks'
import { spansForRun } from '../src/lib/textLinks'
import { TextSegment } from '../src/lib/types'
import { collectTargetIds } from '../src/main/links'
import { mergePdfs } from '../src/ui/pdf'
import { relinkToPages } from '../src/ui/pdfLinks'

describe('nodeIdFromLink', () => {
  it('Figma 프로토타입 링크의 node-id 를 API 노드 id 로', () => {
    expect(
      nodeIdFromLink(
        'https://www.figma.com/proto/TC2ossMZRDbIvjAEgujAtg/Signage-%E2%80%93-Production?node-id=4374-74008&viewport=42'
      )
    ).toBe('4374:74008')
    expect(nodeIdFromLink('https://figma.com/design/abc/File?node-id=12%3A34')).toBe('12:34')
  })

  it('Figma 가 아니거나 node-id 가 없으면 null — 일반 웹 링크는 건드리지 않는다', () => {
    expect(nodeIdFromLink('https://3-form.com/tech-specs/1650')).toBeNull()
    expect(nodeIdFromLink('https://www.figma.com/community/plugin/123')).toBeNull()
    expect(nodeIdFromLink('https://www.figma.com/proto/abc/File')).toBeNull()
    expect(nodeIdFromLink('https://notfigma.com/proto/abc/File?node-id=1-2')).toBeNull()
    expect(nodeIdFromLink('not a url')).toBeNull()
  })

  it('다시 그린 텍스트의 자리표시도 푼다', () => {
    expect(nodeIdFromLink(NODE_LINK_SCHEME + '12:34')).toBe('12:34')
    expect(nodeIdFromLink(NODE_LINK_SCHEME)).toBeNull()
  })

  it('인스턴스 안 노드 id 의 대시도 콜론으로', () => {
    expect(normalizeNodeId('I12-34;56-78')).toBe('I12:34;56:78')
  })
})

describe('linkUrlOf', () => {
  it('URL 은 그대로, NODE 는 자리표시, 없으면 빈 문자열', () => {
    expect(linkUrlOf({ type: 'URL', value: 'https://x.io' })).toBe('https://x.io')
    expect(linkUrlOf({ type: 'NODE', value: '1:2' })).toBe(NODE_LINK_SCHEME + '1:2')
    expect(linkUrlOf(null)).toBe('')
    expect(linkUrlOf({ type: 'URL', value: '' })).toBe('')
  })
})

function segment(
  start: number,
  end: number,
  options: { link?: TextSegment['hyperlink']; decoration?: string } = {}
): TextSegment {
  return {
    start,
    end,
    fontName: { family: 'Inter', style: 'Regular' },
    fontSize: 12,
    fills: [{ r: 0, g: 0, b: 0, a: 1 }],
    letterSpacing: { unit: 'PERCENT', value: 0 },
    textDecoration: options.decoration ?? 'NONE',
    textCase: 'ORIGINAL',
    features: {},
    hyperlink: options.link ?? null,
    listType: 'NONE',
    indentation: 0
  }
}

describe('spansForRun', () => {
  const characters = 'See Appendix A for details'

  it('NODE 링크는 자리표시 URL 의 링크 구간이 된다', () => {
    const segments = [
      segment(0, 4),
      segment(4, 14, { link: { type: 'NODE', value: '4309:8222' }, decoration: 'UNDERLINE' }),
      segment(14, 26)
    ]
    const { links, decorations, next } = spansForRun(characters, 0, characters, segments)
    expect(links).toEqual([{ start: 4, end: 14, url: NODE_LINK_SCHEME + '4309:8222' }])
    expect(decorations).toEqual([{ start: 4, end: 14, kind: 'UNDERLINE' }])
    expect(next).toBe(26)
  })

  it('굵기로 갈라진 같은 밑줄은 한 구간으로, 종류가 다르면 따로', () => {
    const segments = [
      segment(0, 4, { decoration: 'UNDERLINE' }),
      segment(4, 8, { decoration: 'UNDERLINE' }),
      segment(8, 12, { decoration: 'STRIKETHROUGH' })
    ]
    const { decorations } = spansForRun('abcdefghijkl', 0, 'abcdefghijkl', segments)
    expect(decorations).toEqual([
      { start: 0, end: 8, kind: 'UNDERLINE' },
      { start: 8, end: 12, kind: 'STRIKETHROUGH' }
    ])
  })

  it('run 이 원문 일부면 그 구간 안으로 잘라 run 기준 인덱스로', () => {
    const segments = [segment(0, 26, { decoration: 'UNDERLINE' })]
    const { decorations } = spansForRun(characters, 4, 'Appendix A', segments)
    expect(decorations).toEqual([{ start: 0, end: 10, kind: 'UNDERLINE' }])
  })
})

/** 쪽마다 URI 링크 주석 하나씩 단 한 쪽짜리 PDF */
async function partWithLink(url: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([200, 100])
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [10, 10, 50, 30],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) }
  })
  page.node.addAnnot(doc.context.register(annot))
  return await doc.save()
}

function linkOf(document: PDFDocument, pageIndex: number): PDFDict | undefined {
  const page = document.getPages()[pageIndex]
  const annots = page.node.Annots()
  if (annots === undefined || annots.size() === 0) return undefined
  return document.context.lookup(annots.get(0), PDFDict)
}

function destPageIndex(document: PDFDocument, annot: PDFDict): number {
  const dest = annot.lookup(PDFName.of('Dest'))
  const ref = (dest as unknown as { get: (i: number) => unknown }).get(0)
  return document.getPages().findIndex((page) => page.ref === ref)
}

describe('relinkToPages', () => {
  const proto = (id: string): string =>
    `https://www.figma.com/proto/KEY/File?node-id=${id.replace(':', '-')}&viewport=1`

  it('이번 내보내기의 프레임을 가리키는 figma.com 링크는 그 쪽 이동이 된다', async () => {
    const merged = await mergePdfs(
      [
        { index: 0, bytes: await partWithLink(proto('20:1')) },
        { index: 1, bytes: await partWithLink('https://3-form.com/specs') },
        { index: 2, bytes: await partWithLink(proto('99:9')) }
      ],
      { title: 't', createdAt: new Date(0), linkTargets: new Map([['20:1', 2]]) }
    )
    expect(merged.linksRelinked).toBe(1)

    const doc = await PDFDocument.load(merged.bytes)
    const first = linkOf(doc, 0)
    expect(first?.get(PDFName.of('A'))).toBeUndefined()
    expect(destPageIndex(doc, first as PDFDict)).toBe(2)

    // 일반 웹 링크와, 대상이 내보내기 밖인 figma.com 링크는 그대로
    const web = linkOf(doc, 1)?.lookup(PDFName.of('A'), PDFDict)
    expect(web?.lookup(PDFName.of('URI'))).toBeDefined()
    const outside = linkOf(doc, 2)?.lookup(PDFName.of('A'), PDFDict)
    expect(outside?.lookup(PDFName.of('URI'))).toBeDefined()
  })

  it('풀리지 않은 자리표시는 지운다 — 웹에서 열 수 없는 링크를 남기지 않는다', async () => {
    const doc = await PDFDocument.load(await partWithLink(NODE_LINK_SCHEME + '5:5'))
    const result = relinkToPages(doc, new Map(), new Map([[0, 0]]))
    expect(result).toEqual({ relinked: 0, dropped: 1 })
    expect(doc.getPages()[0].node.Annots()?.size()).toBe(0)
  })

  it('linkTargets 를 안 주면 링크를 건드리지 않는다', async () => {
    const merged = await mergePdfs([{ index: 0, bytes: await partWithLink(proto('1:1')) }], {
      title: 't',
      createdAt: new Date(0)
    })
    expect(merged.linksRelinked).toBe(0)
    const doc = await PDFDocument.load(merged.bytes)
    expect(linkOf(doc, 0)?.lookup(PDFName.of('A'), PDFDict)).toBeDefined()
  })
})

describe('fileKeyFromLink', () => {
  it('figma.com 링크의 파일 키, 아니면 null', () => {
    expect(fileKeyFromLink('https://www.figma.com/proto/TC2oss/File?node-id=1-2')).toBe('TC2oss')
    expect(fileKeyFromLink('https://3-form.com/tech-specs/1650')).toBeNull()
  })
})

describe('collectTargetIds — 리액션 자리와 이 파일 figma.com 링크', () => {
  const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height })

  function fakeTree(): SceneNode {
    const button = {
      type: 'FRAME',
      visible: true,
      absoluteBoundingBox: box(110, 220, 80, 20),
      reactions: [
        {
          trigger: { type: 'ON_CLICK' },
          actions: [{ type: 'NODE', destinationId: '30:1', navigation: 'NAVIGATE' }]
        },
        {
          trigger: { type: 'ON_HOVER' },
          actions: [{ type: 'NODE', destinationId: '30:2', navigation: 'NAVIGATE' }]
        }
      ],
      children: []
    }
    const text = {
      type: 'TEXT',
      visible: true,
      characters: 'See Appendix A',
      reactions: [],
      getStyledTextSegments: () => [
        { hyperlink: { type: 'URL', value: 'https://www.figma.com/proto/KEY/F?node-id=40-5' } },
        { hyperlink: { type: 'URL', value: 'https://3-form.com/x' } }
      ]
    }
    const hidden = {
      type: 'FRAME',
      visible: false,
      reactions: [
        {
          trigger: { type: 'ON_CLICK' },
          actions: [{ type: 'NODE', destinationId: '99:9', navigation: 'NAVIGATE' }]
        }
      ],
      children: []
    }
    return {
      type: 'FRAME',
      visible: true,
      reactions: [],
      children: [button, text, hidden]
    } as unknown as SceneNode
  }

  it('클릭 리액션은 자리까지, figma.com 텍스트 링크는 대상만, 숨은 레이어는 빼고', () => {
    Object.assign(globalThis, { figma: {} })
    const found = {
      targets: new Set<string>(),
      areas: [] as Array<{ box: unknown; target: string }>
    }
    collectTargetIds(fakeTree(), found as never, Date.now() + 1000)
    expect([...found.targets].sort()).toEqual(['30:1', '30:2', '40:5'])
    expect(found.areas).toEqual([{ box: box(110, 220, 80, 20), target: '30:1' }])
  })

  it('파일 키를 알면 다른 파일의 figma.com 링크는 대상이 아니다', () => {
    Object.assign(globalThis, { figma: { fileKey: 'OTHER' } })
    const found = { targets: new Set<string>(), areas: [] }
    collectTargetIds(fakeTree(), found as never, Date.now() + 1000)
    expect(found.targets.has('40:5')).toBe(false)
  })
})

describe('addAreaLinks', () => {
  it('리액션 자리는 머지 뒤 대상 쪽으로 가는 링크가 되고, 대상이 없으면 사라진다', async () => {
    const blank = async (): Promise<Uint8Array> => {
      const doc = await PDFDocument.create()
      doc.addPage([200, 100])
      return await doc.save()
    }
    const merged = await mergePdfs(
      [
        { index: 0, bytes: await blank() },
        { index: 1, bytes: await blank() }
      ],
      {
        title: 't',
        createdAt: new Date(0),
        linkTargets: new Map([['30:1', 1]]),
        linkAreas: new Map([
          [
            0,
            [
              { x: 10, y: 20, width: 50, height: 10, target: '30:1' },
              { x: 0, y: 0, width: 5, height: 5, target: '77:7' }
            ]
          ]
        ])
      }
    )
    expect(merged.linksRelinked).toBe(1)
    const doc = await PDFDocument.load(merged.bytes)
    expect(doc.getPages()[0].node.Annots()?.size()).toBe(1)
    const annot = linkOf(doc, 0) as PDFDict
    expect(destPageIndex(doc, annot)).toBe(1)
    const rect = annot.lookup(PDFName.of('Rect'))?.toString()
    expect(rect).toBe('[ 10 70 60 80 ]')
  })
})
