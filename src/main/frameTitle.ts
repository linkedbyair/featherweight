// Bookmark title and section for an exported frame.
//
// Studios name frames "001", "Frame 4651" — fine for ordering, useless in a PDF's bookmark panel.
// When the name is like that, the frame's first line of text (top-most, then left-most) is the title.

const GENERIC = /^(\d+([.\-–]\d+)*|frame( \d+)?|group( \d+)?|page( \d+)?)$/i
const MAX_TITLE = 80

export function frameTitle(frame: SceneNode): string {
  const name = frame.name.trim()
  if (name !== '' && !GENERIC.test(name)) return name
  const first = firstText(frame)
  return first ?? (name === '' ? 'Untitled' : name)
}

export function frameSection(frame: SceneNode): string | undefined {
  for (let node = frame.parent; node !== null; node = node.parent) {
    if (node.type === 'SECTION') return node.name
    if (node.type === 'PAGE' || node.type === 'DOCUMENT') return undefined
  }
  return undefined
}

function firstText(frame: SceneNode): string | undefined {
  if (!('findAllWithCriteria' in frame)) return undefined
  const box = frame.absoluteBoundingBox
  let best: { y: number; x: number; text: string } | undefined
  try {
    for (const node of frame.findAllWithCriteria({ types: ['TEXT'] })) {
      if (node.visible === false || node.characters.trim() === '') continue
      const at = node.absoluteBoundingBox
      if (at === null || box === null) continue
      // inside the frame only — text hanging off the canvas edge is not a heading
      if (at.y < box.y - 1 || at.x < box.x - 1 || at.y > box.y + box.height) continue
      const text = node.characters.split(/[\n\u2028\u2029]/)[0].trim()
      // a lone letter or number ("C", "2") is a big graphic, not a heading
      if (text.replace(/\s/g, '').length < 3) continue
      const row = Math.round(at.y / 8) // same line within a few px counts as one row
      if (best === undefined || row < best.y || (row === best.y && at.x < best.x))
        best = { y: row, x: at.x, text }
    }
  } catch {
    return undefined
  }
  if (best === undefined) return undefined
  return best.text.length > MAX_TITLE ? `${best.text.slice(0, MAX_TITLE - 1)}…` : best.text
}
