import { describe, expect, it } from 'vitest'

import { dropBackgroundBlur } from '../src/main/effects'

describe('dropBackgroundBlur', () => {
  it('removes only visible background blurs, deep in the tree, keeping other effects', () => {
    const panel = {
      effects: [
        { type: 'BACKGROUND_BLUR', visible: true, radius: 4 },
        { type: 'DROP_SHADOW', visible: true }
      ]
    }
    const hidden = { effects: [{ type: 'BACKGROUND_BLUR', visible: false }] }
    const root = { effects: [], children: [{ children: [panel, hidden] }] }
    expect(dropBackgroundBlur(root as unknown as SceneNode)).toBe(1)
    expect(panel.effects).toEqual([{ type: 'DROP_SHADOW', visible: true }])
    expect(hidden.effects).toHaveLength(1)
  })
})
