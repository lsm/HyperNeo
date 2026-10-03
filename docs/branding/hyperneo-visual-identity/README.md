# HyperNeo visual identity

Version 1.0 · 28 September 2026

This is the source-of-truth package for the HyperNeo identity built around approved mark **06**, the Qian center pair. It brings together brand foundations, logo masters, production vectors, color and type specifications, product patterns, layouts, usage guidance, and starter templates. The system expresses quiet perception, grounded confidence, and decisive action for people making consequential decisions.

## Start here

- Read [`index.html`](index.html) for the complete visual guide and live examples.
- Open [`identity-system-board-02.svg`](identity-system-board-02.svg) for the compact overview.
- Use [`assets/logo-mark-06-jade.svg`](assets/logo-mark-06-jade.svg) on deep green surfaces and [`assets/logo-mark-06-ink.svg`](assets/logo-mark-06-ink.svg) on light surfaces.
- Use [`assets/lockup-06-dark.svg`](assets/lockup-06-dark.svg), [`assets/lockup-06-light.svg`](assets/lockup-06-light.svg), [`assets/lockup-06-white.svg`](assets/lockup-06-white.svg), or [`assets/lockup-06-stacked.svg`](assets/lockup-06-stacked.svg) when a wordmark is needed.
- Use [`brand-tokens.css`](brand-tokens.css) or [`brand-tokens.json`](brand-tokens.json) for product and web implementation.
- Adapt the editable layouts in [`templates/`](templates/index.html) for presentations, executive briefs, letters, and social posts.
- Review [`ASSET-LICENSE.md`](ASSET-LICENSE.md) before reusing or redistributing any brand materials.

## Brand foundation

**Purpose:** Give leaders a calm, capable partner for decisions with consequence.

**Promise:** See through complexity and make the next move clear.

**Principles:** Quiet, not passive. Insight, not spectacle. Power held in reserve. Respect the person making the decision.

**Story:** The center pair distills the Qian hexagram and the Neo idea into a simple relationship: one grounded, uninterrupted signal beside one deliberate opening. The mark suggests a composed mind that can see the underlying pattern, hold complexity without displaying it, and reveal the useful choice at the right moment. It does not illustrate a literal Matrix screen or claim that the assistant makes decisions for the human.

## Approved logo geometry

The master `viewBox` is 144 × 377 units. The left bar and each half of the right bar are 55 units wide. The right-side vertical opening and the horizontal opening are each 34 units. Keep the mark upright: solid left, split right. Keep the openings, proportions, and corner radius exactly as drawn.

Leave at least 34 source units of clear space around the mark. Render the master at 48 CSS pixels tall or larger; below that, including avatars, favicons and compact product surfaces, use mark 06S (below). Use the favicon tile at 32 × 32 pixels or larger. The standalone mark is preferable to a wordmark below 200 pixels wide. Never connect, rotate, mirror, crop, outline, skew, or add effects that change the silhouette. Do not use jade on paper for small marks or text.

### Small-size mark 06S

Below 48 CSS pixels, use mark 06S ([`assets/logo-mark-06s-white.svg`](assets/logo-mark-06s-white.svg), [`-ink`](assets/logo-mark-06s-ink.svg), [`-jade`](assets/logo-mark-06s-jade.svg)) instead of the master. It keeps the story, solid bar left and split bar right, on sturdier proportions so it holds at 16 to 32 pixels and fills square and circular containers. The `viewBox` is 102 × 176 units: 42-unit bars, an 18-unit vertical opening, an 18-unit horizontal opening and a corner radius of 6. Minimum rendered height is 16 CSS pixels; use the master at 48 pixels and up.

In a square or circular container, set padding optically, not equally: a tall mark takes less room above and below than at the sides. In the 32-unit favicon tile ([`assets/favicon-06s.svg`](assets/favicon-06s.svg)) 06S stands 22 units tall and 12.75 wide, centered.

## Color management

The hex and RGB values in `brand-tokens.json` are the digital source values in **sRGB IEC61966-2.1**. The listed CMYK numbers are a color-managed conversion using the **CGATS21_CRPC6.icc profile** for the **CGATS21-2-CRPC6 printing condition**, with relative-colorimetric intent. They are a reference starting point, not a guarantee of an exact printed match. Ask the printer for the intended press condition and use its ICC profile; approve a hard proof on the actual stock before production. The [official ICC registry entry](https://registry.color.org/profile-registry/CGATS21_CRPC6) identifies this profile, its provider, and its printing condition.

No Pantone spot color has been approved. Do not guess a Pantone equivalent from a display or conversion chart. If a spot ink is required, choose it from a current physical fan deck, then verify a press proof. Color values and print profile details are also in the JSON token file.

## Color plates

Each surface allows only the mark colors listed; the first is the default. The mark is a graphic, so WCAG 3:1 contrast against the surface is the floor.

| Surface | Mark colors |
| --- | --- |
| Night `#07110C` | Jade (11.9:1), Mint (14.5:1), Paper (17.3:1) |
| Forest `#102019` | Jade (10.5:1), Mint (12.7:1), Paper (15.3:1), Slate (5.3:1) |
| Jade `#53E59A` | Night (11.9:1), Forest (10.5:1) |
| Mint `#9AF2C0` | Night (14.5:1), Forest (12.7:1) |
| Paper `#F2F4EF` | Ink (17.3:1), Forest (15.3:1) — not Slate (2.9:1) |
| Mist `#DCE5DD` | Ink (14.9:1), Forest (13.1:1) |

### The mark in product chrome

Inside product UI, where the mark is a control rather than a signature, use 06S in Paper on dark surfaces and Ink on light surfaces, one flat fill. Never tint it with a product accent or change its color on hover; hover changes the control, not the mark. Jade stays reserved for brand surfaces: splash, app icon, marketing and the favicon tile.

Open question: Neo uses a warm conversation palette while the identity is jade on night. Whether Neo adopts the brand palette or the guide defines Neo as a sub-palette is undecided; until then product chrome stays neutral.

## Typography and licensing

Use **Inter** for English product and editorial typography. For Simplified Chinese, use **Noto Sans SC** where installed, then platform system sans fallbacks. Use the mono stack for compact labels, metadata, and technical states only. Keep body text at 16 px or larger where practical; do not apply English-style tracking to Chinese paragraphs. The type scale and fallbacks are defined in `brand-tokens.json` and `brand-tokens.css`.

Font binaries are intentionally not bundled. Inter is distributed under the SIL Open Font License; Noto Sans CJK is also distributed under the SIL Open Font License. Obtain the fonts from their official [Inter](https://rsms.me/inter/) and [Noto CJK](https://github.com/notofonts/noto-cjk) sources and follow each font's license when redistributing it. This identity package does not change those font licenses.

## Package map

```text
assets/       SVG logo masters, favicon, photography direction, PDF/EPS vectors
elements/     Decision frame, split rule, focus corner
patterns/     Signal field, quiet grid
templates/    Editable SVG layouts and template index
tools/        Standard-library vector export script
```

SVG is the master format for screens and editable vector artwork. PDF suits print and presentations; EPS supports legacy production workflows. The PDF/EPS lockups use Helvetica text, while SVG lockups retain live text in a system stack. For final typesetting, confirm the installed font and outline only the wordmark in a vector application before sending the mechanical to a printer.

## Generate print vectors

The exporter uses only the Python standard library:

```sh
python3 tools/export-vector-assets.py
```

It writes one-page PDF and EPS variants to `assets/exports/`. The exporter is software and remains covered by the repository's Apache License 2.0; the logo and other brand materials are governed by [`ASSET-LICENSE.md`](ASSET-LICENSE.md).

## Governance and change control

Mark 06 is the approved master. Preserve its geometry in all exports and derivative layouts. Store new logo variants beside the SVG masters, regenerate the PDF/EPS library from the exporter, update the token source before implementation copies, and record material changes in this guide. Do not invent color values, use unapproved spot inks, embed font files, or make a new logo geometry for one-off placements. Route proposed identity changes through the brand owner for review.

Give every meaningful logo image accessible alternative text unless the adjacent text already names the brand; decorative pattern instances use empty alt text. Keep text contrast at WCAG AA for normal text and pair semantic color with labels or shapes. Use clear, plain language in every language and preserve the decision-maker's agency.

## Rights

The brand artwork and identity materials in this directory are all rights reserved, subject to the scope and exceptions in [`ASSET-LICENSE.md`](ASSET-LICENSE.md). The root Apache-2.0 license continues to cover repository software and the vector export helper; it does not grant permission to use the HyperNeo brand identity. Fonts and external color-management profiles remain subject to their own license terms.
