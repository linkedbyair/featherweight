// Effects that some PDF readers can't draw.
//
// Figma exports a background blur (the frosted-glass look) as a blurred copy of what's behind, clipped
// by a soft mask. Bluebeam draws that as an opaque white box over the drawing (WCMA signage set, plaque
// details). Removing the blur keeps the panel's translucent fill, which every reader draws correctly.

/** Removes visible background blurs inside root. Returns how many layers changed. */
export function dropBackgroundBlur(root: SceneNode): number {
  let changed = 0
  const visit = (node: SceneNode): void => {
    if ('effects' in node && Array.isArray(node.effects) && node.effects.length > 0) {
      const kept = node.effects.filter(
        (effect) => !(effect.type === 'BACKGROUND_BLUR' && effect.visible !== false)
      )
      if (kept.length !== node.effects.length) {
        try {
          node.effects = kept
          changed += 1
        } catch {
          // locked or read-only (inside an instance that couldn't be detached) — leave it
        }
      }
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(root)
  return changed
}
