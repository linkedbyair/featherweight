import { describe, expect, it } from 'vitest'

import { planPage, printedInches } from '../src/lib/pageSize'

describe('planPage', () => {
  it('fills tabloid from a 1920×1248 frame: 17 × 11 exactly, trimming the extra height evenly', () => {
    const plan = planPage(1920, 1248, 'tabloid', 'fill')
    expect(plan).not.toBeNull()
    const inches = printedInches(plan!)
    expect(inches.width).toBeCloseTo(17, 4)
    expect(inches.height).toBeCloseTo(11, 4)
    expect(plan!.userUnit).toBeCloseTo(0.6375, 6)
    expect(plan!.mediaBox).toEqual([0, 0, 1920, 1248])
    expect(plan!.cropBox[1]).toBeCloseTo(2.823529, 5) // ~0.025 in off top and bottom
  })

  it('fits a narrower 1912-wide frame by padding instead of cutting', () => {
    const plan = planPage(1912, 1248, 'tabloid', 'fit')!
    const inches = printedInches(plan)
    expect(inches.width).toBeCloseTo(17, 4)
    expect(inches.height).toBeCloseTo(11, 4)
    expect(plan.mediaBox[0]).toBeLessThanOrEqual(0)
    expect(plan.mediaBox[2]).toBeGreaterThanOrEqual(1912)
    expect(plan.mediaBox[1]).toBeCloseTo(0, 6)
  })

  it('follows the frame orientation', () => {
    const portrait = printedInches(planPage(1000, 1400, 'letter', 'fit')!)
    expect(portrait.width).toBeCloseTo(8.5, 4)
    expect(portrait.height).toBeCloseTo(11, 4)
  })

  it('leaves the page alone for frame size', () => {
    expect(planPage(1920, 1248, 'frame', 'fill')).toBeNull()
  })
})
