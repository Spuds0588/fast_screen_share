#!/usr/bin/env python3
"""Generate the fast_screen_share app icons.

No design files, no binary sources in the repo: the mark is drawn from
primitives and downscaled with Lanczos so it stays crisp at every size.

Usage:  python3 tools/make_icons.py

Writes:
  icons/icon-192.png            192x192  rounded square
  icons/icon-512.png            512x512  rounded square
  icons/icon-maskable-512.png   512x512  full bleed, content inside the
                                          Android mask safe zone
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"

SUPERSAMPLE = 4  # draw big, scale down: cheap anti-aliasing

BLUE_TOP = (17, 124, 226)     # #117ce2
BLUE_BOTTOM = (10, 63, 122)   # #0a3f7a
BOLT = (11, 92, 176)          # #0b5cb0, the same family as the gradient
WHITE = (255, 255, 255)


def gradient(size: int) -> Image.Image:
    """Diagonal blue gradient, drawn small and stretched for smoothness."""
    small = Image.new("RGB", (64, 64))
    px = small.load()
    for y in range(64):
        for x in range(64):
            t = (x / 63 + y / 63) / 2
            px[x, y] = tuple(
                round(a + (b - a) * t) for a, b in zip(BLUE_TOP, BLUE_BOTTOM)
            )
    return small.resize((size, size), Image.BICUBIC)


def mark(size: int, maskable: bool) -> Image.Image:
    s = size * SUPERSAMPLE
    base = gradient(s)

    if maskable:
        icon = base.convert("RGBA")
        # Android can crop to a circle: keep the mark inside the safe zone.
        content_scale = 0.72
        offset = (1 - content_scale) / 2
        scale = s * content_scale
        origin = s * offset
    else:
        radius = round(s * 0.215)
        mask = Image.new("L", (s, s), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, s - 1, s - 1), radius=radius, fill=255
        )
        icon = base.convert("RGBA")
        icon.putalpha(mask)
        scale = s
        origin = 0.0

    def p(x: float, y: float) -> tuple:
        """Map a 512-space coordinate into this canvas."""
        return (origin + x / 512 * scale, origin + y / 512 * scale)

    draw = ImageDraw.Draw(icon)
    unit = scale / 512  # one 512-space unit in device pixels

    def box(x0, y0, x1, y1, radius, fill):
        draw.rounded_rectangle(
            (p(x0, y0), p(x1, y1)), radius=max(1, round(radius * unit)), fill=fill
        )

    # Monitor, stand, foot.
    box(92, 126, 420, 346, 30, WHITE)
    box(224, 350, 288, 382, 12, WHITE)
    box(180, 386, 332, 408, 11, WHITE)

    # Bolt knocked out of the screen.
    draw.polygon(
        [
            p(280, 152),
            p(206, 232),
            p(246, 232),
            p(232, 312),
            p(306, 224),
            p(266, 224),
        ],
        fill=BOLT,
    )

    return icon.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ]
    for name, size, maskable in targets:
        path = OUT / name
        mark(size, maskable).save(path, "PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
