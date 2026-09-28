# HyperNeo visual identity

This package defines a production-ready visual identity around approved logo **06**, the Qian center pair. It connects the brand story—quiet perception, grounded confidence, and decisive action—to an asset library for product, web, presentations, and print.

## Start here

- Open [`index.html`](index.html) for the visual guide and interactive examples.
- Review [`identity-system-board-02.svg`](identity-system-board-02.svg) for a one-page identity overview.
- Use [`assets/logo-mark-06-jade.svg`](assets/logo-mark-06-jade.svg) as the primary logo on dark surfaces.
- Use [`assets/logo-mark-06-ink.svg`](assets/logo-mark-06-ink.svg) on light surfaces. The white version is for dark photography or approved dark colors.
- Use [`assets/lockup-06-dark.svg`](assets/lockup-06-dark.svg), [`assets/lockup-06-light.svg`](assets/lockup-06-light.svg), or [`assets/lockup-06-stacked.svg`](assets/lockup-06-stacked.svg) when the wordmark is needed.
- Use [`brand-tokens.css`](brand-tokens.css) or [`brand-tokens.json`](brand-tokens.json) to carry color, type, spacing, grid, motion, and geometry into product interfaces.

## Approved logo geometry

The 144 × 377 viewBox has a 55-unit uninterrupted left bar, a 55-unit split right bar, and two 171.5-unit right segments. Both the horizontal opening and the opening between right segments are 34 units. The mark stays upright: solid left, split right.

Preserve the openings, orientation, corner radius, and relative proportions. Do not connect the split segments, mirror or rotate the mark, crop the silhouette, add outlines, or apply effects that alter its shape. Keep at least 34 source units of clear space around it. At small sizes, prefer the standalone mark and render as vector; place it on a high-contrast tile for square avatars and favicons.

## Logo family and formats

The `assets` directory contains three standalone mark colors, a favicon tile, and horizontal or stacked lockups. SVG is the master format for UI, browser, and responsive use. The [`assets/exports/` library](assets/exports/index.html) contains vector PDF and EPS counterparts for print and presentation workflows. The SVG lockups keep the wordmark as live text in the Inter / Helvetica Neue system stack; the PDF/EPS lockups use standard Helvetica text. For a printer-ready wordmark in a specific font, open the SVG master in a vector editor, confirm the font, and convert only the wordmark to outlines.

Reusable graphic assets are in `patterns/` and `elements/`. They are simple vector artwork with transparent backgrounds. Patterns should remain quiet and never compromise text contrast. Use components to make a recommendation easier to scan, not as decoration.

## Visual system

- **Color:** Night and Forest create calm surfaces; Paper and Mist support long reading; Jade marks focus and action. Avoid Jade on Paper for text or small marks. Sky, Amber, and Coral provide secondary data meaning and always need a text or shape cue.
- **Typography:** Inter is preferred where available, with Helvetica Neue, Helvetica, and Arial fallbacks. Use sans-serif for interface and headlines, mono for labels and system state. Keep body copy at 16 px or above where practical.
- **Layout:** Use a 4 px baseline, a 12-column grid, 24 px gutters, and a content maximum near 1200 px. Keep alignment consistent and reserve space around important decisions.
- **Shape:** Use 8 / 12 / 16 / 20 px corner radii in increasing hierarchy. UI icons use a 2 px rounded stroke at 16, 20, or 24 px.
- **Motion:** Use 160 ms for quick feedback and 240 ms for standard transitions. Honor reduced-motion preferences. The logo’s static geometry never morphs.
- **Voice:** State the recommendation, explain the reason, name the trade-off, and return agency to the decision-maker.

## Regenerate print vectors

The exporter uses only the Python standard library:

```sh
python3 tools/export-vector-assets.py
```

It writes seven one-page PDF and seven EPS files to `assets/exports/`. Their mark paths use the approved 06 dimensions; lockup text is live text for downstream editing.

## Source files

```text
assets/       SVG logo masters, favicon, print exports
elements/     Decision frame, split rule, focus corner
patterns/     Signal field, quiet grid
tools/        Standard-library vector exporter
```
