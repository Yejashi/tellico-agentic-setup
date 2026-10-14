#!/usr/bin/env python3
"""Renders relay/web's PNG icons from the same shapes as icon.svg.

iOS takes a home-screen icon only as PNG, and this repository adds no image
tooling, so this is a tiny stdlib rasteriser: 4x4 supersampling over a dark
rounded square, a teal T and three node dots -- the mark the VS Code extension
uses. Rerun it after changing the shapes:

    python3 relay/make_icons.py
"""

import os
import struct
import zlib

BG = (0x0F, 0x13, 0x14)
TEAL = (0x2B, 0xB3, 0xA3)
DOT = (0xE9, 0xF7, 0xF5)

# In the 64-unit space of icon.svg.
SEGMENTS = [((17, 19), (47, 19)), ((32, 19), (32, 46))]
STROKE = 3.5  # half the stroke width
DOTS = [(17, 19), (47, 19), (32, 47)]
DOT_R = 5.0


def _segment_distance(px, py, a, b):
    ax, ay = a
    bx, by = b
    dx, dy = bx - ax, by - ay
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    cx, cy = ax + t * dx, ay + t * dy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def _sample(u, v, full_bleed):
    """Colour at a point in icon units, or None outside the rounded square."""
    if not full_bleed:
        r = 14.0
        cx = min(max(u, r), 64 - r)
        cy = min(max(v, r), 64 - r)
        if (u - cx) ** 2 + (v - cy) ** 2 > r * r:
            return None
    for d in DOTS:
        if (u - d[0]) ** 2 + (v - d[1]) ** 2 <= DOT_R * DOT_R:
            return DOT
    for a, b in SEGMENTS:
        if _segment_distance(u, v, a, b) <= STROKE:
            return TEAL
    return BG


def render(size, full_bleed):
    """RGBA rows. full_bleed fills the square: iOS and maskable icons round
    their own corners, and a transparent corner would show as black."""
    ss = 4
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    u = (x + (sx + 0.5) / ss) * 64.0 / size
                    v = (y + (sy + 0.5) / ss) * 64.0 / size
                    if full_bleed:
                        # Keep the mark inside the maskable safe zone.
                        u = 32 + (u - 32) / 0.8
                        v = 32 + (v - 32) / 0.8
                    colour = _sample(u, v, full_bleed)
                    if colour is not None:
                        acc[0] += colour[0]
                        acc[1] += colour[1]
                        acc[2] += colour[2]
                        acc[3] += 255
            n = ss * ss
            alpha = acc[3] // n
            if alpha:
                row += bytes((acc[0] * 255 // acc[3], acc[1] * 255 // acc[3], acc[2] * 255 // acc[3], alpha))
            else:
                row += bytes((0, 0, 0, 0))
        rows.append(bytes(row))
    return rows


def png(rows, size):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def main():
    web = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
    for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
        path = os.path.join(web, name)
        with open(path, "wb") as handle:
            handle.write(png(render(size, full_bleed=True), size))
        print("wrote %s (%dx%d)" % (path, size, size))


if __name__ == "__main__":
    main()
