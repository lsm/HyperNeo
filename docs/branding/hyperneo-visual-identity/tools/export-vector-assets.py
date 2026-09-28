from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPORTS = ROOT / "assets" / "exports"
BAR = 55.0
GAP = 34.0
HEIGHT = 377.0
SEGMENT = (HEIGHT - GAP) / 2
CORNER = 5.5
CURVE = 0.552284749831


def number(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".") or "0"


def rgb(hex_color: str) -> tuple[float, float, float]:
    color = hex_color.removeprefix("#")
    return tuple(int(color[index:index + 2], 16) / 255 for index in (0, 2, 4))


def rounded_rect_pdf(x: float, y: float, width: float, height: float, radius: float) -> str:
    k = radius * CURVE
    return "\n".join([
        f"{number(x + radius)} {number(y)} m",
        f"{number(x + width - radius)} {number(y)} l",
        f"{number(x + width - radius + k)} {number(y)} {number(x + width)} {number(y + radius - k)} {number(x + width)} {number(y + radius)} c",
        f"{number(x + width)} {number(y + height - radius)} l",
        f"{number(x + width)} {number(y + height - radius + k)} {number(x + width - radius + k)} {number(y + height)} {number(x + width - radius)} {number(y + height)} c",
        f"{number(x + radius)} {number(y + height)} l",
        f"{number(x + radius - k)} {number(y + height)} {number(x)} {number(y + height - radius + k)} {number(x)} {number(y + height - radius)} c",
        f"{number(x)} {number(y + radius)} l",
        f"{number(x)} {number(y + radius - k)} {number(x + radius - k)} {number(y)} {number(x + radius)} {number(y)} c",
        "h",
    ])


def rounded_rect_eps(x: float, y: float, width: float, height: float, radius: float) -> str:
    k = radius * CURVE
    return "\n".join([
        f"{number(x + radius)} {number(y)} moveto",
        f"{number(x + width - radius)} {number(y)} lineto",
        f"{number(x + width - radius + k)} {number(y)} {number(x + width)} {number(y + radius - k)} {number(x + width)} {number(y + radius)} curveto",
        f"{number(x + width)} {number(y + height - radius)} lineto",
        f"{number(x + width)} {number(y + height - radius + k)} {number(x + width - radius + k)} {number(y + height)} {number(x + width - radius)} {number(y + height)} curveto",
        f"{number(x + radius)} {number(y + height)} lineto",
        f"{number(x + radius - k)} {number(y + height)} {number(x)} {number(y + height - radius + k)} {number(x)} {number(y + height - radius)} curveto",
        f"{number(x)} {number(y + radius)} lineto",
        f"{number(x)} {number(y + radius - k)} {number(x + radius - k)} {number(y)} {number(x + radius)} {number(y)} curveto",
        "closepath",
    ])


def mark_shapes(pdf: bool, color: str, scale: float = 1, origin: tuple[float, float] = (0, 0)) -> str:
    red, green, blue = rgb(color)
    result = [f"{number(red)} {number(green)} {number(blue)} {'rg' if pdf else 'setrgbcolor'}"]
    ox, oy = origin
    for x, y, width, height in [(0, 0, BAR, HEIGHT), (BAR + GAP, 0, BAR, SEGMENT), (BAR + GAP, SEGMENT + GAP, BAR, SEGMENT)]:
        path = rounded_rect_pdf if pdf else rounded_rect_eps
        shape = path(ox + x * scale, oy + y * scale, width * scale, height * scale, CORNER * scale)
        result.append(shape + (" f" if pdf else "\nfill"))
    return "\n".join(result)


def pdf_document(path: Path, width: float, height: float, stream: str, with_font: bool = False) -> None:
    resources = "/Font << /F1 5 0 R >>" if with_font else ""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {number(width)} {number(height)}] /Resources << {resources} >> /Contents 4 0 R >>".encode(),
        f"<< /Length {len(stream.encode())} >>\nstream\n{stream}\nendstream".encode(),
    ]
    if with_font:
        objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, object_body in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode())
        output.extend(object_body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode())
    output.extend(b"0000000000 65535 f\r\n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n\r\n".encode())
    output.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode())
    path.write_bytes(output)


def eps_document(path: Path, width: float, height: float, title: str, body: str) -> None:
    content = "\n".join([
        "%!PS-Adobe-3.0 EPSF-3.0",
        f"%%Title: {title}",
        f"%%BoundingBox: 0 0 {int(width)} {int(height)}",
        f"%%HiResBoundingBox: 0 0 {number(width)} {number(height)}",
        "%%LanguageLevel: 2",
        "%%EndComments",
        body,
        "%%EOF",
        "",
    ])
    path.write_text(content)


def export_mark(name: str, color: str) -> None:
    shapes = mark_shapes(True, color)
    pdf_document(EXPORTS / f"{name}.pdf", 144, 377, shapes)
    eps_document(EXPORTS / f"{name}.eps", 144, 377, f"HyperNeo {name}", mark_shapes(False, color))


def export_lockup(name: str, mark_color: str, word_color: str, stacked: bool = False) -> None:
    if stacked:
        width, height, scale, origin, baseline, font_size, tracking = 320, 230, 0.36, (134.08, 76.28), 12, 47, -2.3
        text_x = 58.35
        text_operator = "Tm"
        text_matrix = f"1 0 0 1 {number(text_x)} {number(baseline)}"
    else:
        width, height, scale, origin, baseline, font_size, tracking = 500, 100, 0.2, (0, 12.6), 28, 58, -2.8
        text_x = 58
        text_operator = "Tm"
        text_matrix = f"1 0 0 1 {number(text_x)} {number(baseline)}"
    red, green, blue = rgb(word_color)
    stream = "\n".join([
        mark_shapes(True, mark_color, scale, origin),
        f"{number(red)} {number(green)} {number(blue)} rg",
        "BT",
        "/F1 " + number(font_size) + " Tf",
        number(tracking) + " Tc",
        text_matrix + " " + text_operator,
        "(HyperNeo) Tj",
        "ET",
    ])
    pdf_document(EXPORTS / f"{name}.pdf", width, height, stream, with_font=True)
    mark_eps = mark_shapes(False, mark_color, scale, origin)
    text_eps = "\n".join([
        "/Helvetica findfont " + number(font_size) + " scalefont setfont",
        f"{number(text_x)} {number(baseline)} moveto {number(tracking)} 0 (HyperNeo) ashow",
    ])
    eps_document(EXPORTS / f"{name}.eps", width, height, f"HyperNeo {name}", mark_eps + "\n" + "\n".join([
        f"{number(red)} {number(green)} {number(blue)} setrgbcolor",
        text_eps,
    ]))


def main() -> None:
    EXPORTS.mkdir(parents=True, exist_ok=True)
    export_mark("mark-06-jade", "#53E59A")
    export_mark("mark-06-ink", "#07110C")
    export_mark("mark-06-white", "#F2F4EF")
    export_lockup("lockup-06-horizontal-dark", "#53E59A", "#F2F4EF")
    export_lockup("lockup-06-horizontal-light", "#07110C", "#07110C")
    export_lockup("lockup-06-horizontal-white", "#F2F4EF", "#F2F4EF")
    export_lockup("lockup-06-stacked-dark", "#53E59A", "#F2F4EF", stacked=True)
    print(f"Wrote seven PDF and seven EPS vector exports to {EXPORTS}")


if __name__ == "__main__":
    main()
