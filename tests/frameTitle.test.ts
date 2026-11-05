import { describe, expect, it } from 'vitest'

import { frameSection, frameTitle } from '../src/main/frameTitle'

function frame(
  name: string,
  texts: Array<{ text: string; x: number; y: number }>,
  parent: unknown = null
) {
  return {
    name,
    parent,
    absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1248 },
    findAllWithCriteria: () =>
      texts.map((t) => ({
        visible: true,
        characters: t.text,
        absoluteBoundingBox: { x: t.x, y: t.y, width: 100, height: 20 }
      }))
  } as unknown as SceneNode
}

describe('frameTitle', () => {
  it('keeps a real frame name', () => {
    expect(frameTitle(frame('C01 Outdoor Program', []))).toBe('C01 Outdoor Program')
  })

  it('numbered or default names use the first line of text, top then left', () => {
    const page = frame('042', [
      { text: 'Linked by Air', x: 1800, y: 1220 },
      { text: 'C', x: 0, y: 0 },
      { text: 'Fabrication Details', x: 30, y: 80 },
      { text: 'C01  Outdoor Program\nPoster', x: 30, y: 28 },
      { text: 'Poster', x: 200, y: 30 }
    ])
    expect(frameTitle(page)).toBe('C01  Outdoor Program')
    expect(frameTitle(frame('Frame 4651', [{ text: 'Cover', x: 0, y: 0 }]))).toBe('Cover')
  })

  it('falls back to the name when there is no text', () => {
    expect(frameTitle(frame('017', []))).toBe('017')
  })
})

describe('frameSection', () => {
  it('names the Figma section a frame sits in', () => {
    const page = { type: 'PAGE', parent: null }
    const section = { type: 'SECTION', name: 'D – Donor Recognition', parent: page }
    expect(frameSection(frame('x', [], section))).toBe('D – Donor Recognition')
    expect(frameSection(frame('x', [], page))).toBeUndefined()
  })
})
