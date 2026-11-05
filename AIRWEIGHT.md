# Airweight

Linked by Air's studio edition of [Featherweight](https://github.com/coffeequickly/featherweight)
(MIT), tuned for exporting print sets — signage design intent, drawing packages — from Figma to PDF
that opens and prints correctly in Bluebeam, Acrobat and Apple Preview.

## What it does on top of Featherweight

**Text**
- Real fonts instead of Figma's Type 3 (Featherweight's core), now also for rotated, mirrored,
  skewed and scaled text, text with a different color per character, and custom underlines.
- *Draw text that can't use its font as plain shapes* (on by default): anything that still can't
  be redrawn — strokes, shadows, emboss effects, emoji like ♿ — becomes vector shapes (or, for
  emoji, an exact 4× picture) instead of Type 3, with an invisible real-font copy on top so it
  stays searchable and keeps its links.
- Text hidden behind another layer (the mirrored back of a sign, seen through the front plaque)
  stays where it was instead of being redrawn on top.
- Text inside a union/subtract shape (engraved or cut-out lettering) is left alone.

**Links**
- Prototype "Navigate to" links, text links to layers, and figma.com links into the same file all
  become page jumps inside the PDF.
- The Result tab warns about links that still go to figma.com (target outside the export, or
  deleted) — fix those in Figma before a set goes out.

**Pages**
- *Print size*: Tabloid 11×17, Letter, A3, A4, ARCH C, ARCH D. Fill (trim the overflow evenly) or
  Fit (blank margins). Done with the PDF's UserUnit and page boxes — the drawing is never rescaled,
  because rescaling breaks Figma's transparency groups in Apple Preview.
- *Add bookmarks* (on by default): one per frame, grouped by Figma section. Frames named just a
  number ("042", "Frame 12") use their first line of text.

**File size**
- Pictures repeated across frames are stored once (lossless).
- For drawing sets with architectural plans, set Images → Largest to 3840 px; the 1920 px default
  turns thin plan lines grey.

## Recommended settings for a signage set

| Where | Setting |
|---|---|
| Start | Balanced, then Images → Largest **3840 px** |
| Fonts | Upload the project fonts (Styrene, Union, …) once |
| Options → Text | Keep hyperlinks ✓ · Fallback font ✓ · Plain shapes ✓ |
| Options → Pages | Print size **Tabloid**, Fill · Add bookmarks ✓ |

After updating the plugin files, close and reopen the plugin window — Figma only loads new code
when the plugin starts.

## Branches

- `lba/internal-links-and-decorations` — the general improvements, kept clean for an upstream PR
  to Featherweight.
- `lba/airweight` — this studio edition (rename, studio defaults, print size, bookmarks).
