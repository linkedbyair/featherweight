// Print page size without touching page content. Figma·DOM·pdf-lib dependency-free.
//
// Scaling the page content (a `cm` around it, or wrapping the page in a form) breaks Figma's
// transparency groups in Apple Preview and iOS: images come out clipped or missing (measured on the
// WCMA signage set). So the physical size is set with /UserUnit — how many 1/72 in one unit is — and
// the visible area with the page boxes. The drawing itself stays exactly as Figma wrote it.

export type PageSizeId = 'frame' | 'tabloid' | 'letter' | 'a3' | 'a4' | 'archC' | 'archD'
export type PageFit = 'fill' | 'fit'

/** Paper sizes in points, portrait. Orientation follows each frame. */
export const PAGE_SIZES: Record<Exclude<PageSizeId, 'frame'>, { width: number; height: number }> = {
  tabloid: { width: 792, height: 1224 },
  letter: { width: 612, height: 792 },
  a3: { width: 841.89, height: 1190.55 },
  a4: { width: 595.28, height: 841.89 },
  archC: { width: 1296, height: 1728 },
  archD: { width: 1728, height: 2592 }
}

export const PAGE_SIZE_IDS: PageSizeId[] = [
  'frame',
  'tabloid',
  'letter',
  'a3',
  'a4',
  'archC',
  'archD'
]

export type Box = [number, number, number, number]

export type PagePlan = {
  /** /UserUnit — physical points per unit */
  userUnit: number
  /** MediaBox in the page's own units. Larger than the frame when fitting (white margins) */
  mediaBox: Box
  /** CropBox — the visible, printed area */
  cropBox: Box
}

/**
 * The boxes that make a frame of width × height units print at the paper size.
 * fill: scale until the paper is covered and trim the overflow evenly (centered).
 * fit: scale until the frame fits and pad evenly with blank margins.
 * Returns null for 'frame' (leave the page alone).
 */
export function planPage(
  width: number,
  height: number,
  size: PageSizeId,
  fit: PageFit
): PagePlan | null {
  if (size === 'frame' || !(width > 0) || !(height > 0)) return null
  const paper = PAGE_SIZES[size]
  const landscape = width > height
  const paperWidth = landscape ? paper.height : paper.width
  const paperHeight = landscape ? paper.width : paper.height

  const scaleX = paperWidth / width
  const scaleY = paperHeight / height
  const userUnit = fit === 'fill' ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY)
  const visibleWidth = paperWidth / userUnit
  const visibleHeight = paperHeight / userUnit
  const dx = (width - visibleWidth) / 2
  const dy = (height - visibleHeight) / 2
  const visible: Box = [dx, dy, width - dx, height - dy].map(round) as Box

  return {
    userUnit: round(userUnit),
    // fit pads outside the frame (negative origin); fill keeps the frame as the media
    mediaBox: fit === 'fit' ? visible : [0, 0, width, height],
    cropBox: visible
  }
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/** Physical size in inches that a plan gives — for the result screen and tests */
export function printedInches(plan: PagePlan): { width: number; height: number } {
  const [x0, y0, x1, y1] = plan.cropBox
  return {
    width: ((x1 - x0) * plan.userUnit) / 72,
    height: ((y1 - y0) * plan.userUnit) / 72
  }
}
