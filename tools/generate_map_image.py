#!/usr/bin/env python3
"""
Simple utility to render a map JSON into a PNG for the Display client.

Usage:
  python tools/generate_map_image.py --map default
  python tools/generate_map_image.py --file ./config/maps/default.json

The script expects map JSON with at least these fields (common in `MapModel`):
  - id (optional)
  - width (cells)
  - height (cells)
  - cellSize (pixels per cell)

If Pillow is not installed, install it with: `pip install Pillow`.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Dict

try:
    from PIL import Image, ImageDraw
except Exception:  # pragma: no cover - runtime import
    print("Pillow is required. Install with: pip install Pillow")
    raise


DEFAULT_OUTPUT_DIR = os.path.join("assets", "maps")
DEFAULT_CONFIG_DIR = os.path.join("config", "maps")


def load_map_json_from_file(path: str) -> Dict:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def render_map_to_image(map_data: Dict, out_path: str) -> None:
    width = int(map_data.get("width", 10))
    height = int(map_data.get("height", 8))
    cell_size = int(map_data.get("cellSize", 64))

    img_w = width * cell_size
    img_h = height * cell_size

    # Safety cap to avoid huge images
    max_dim = 8192
    if img_w > max_dim or img_h > max_dim:
        scale = min(max_dim / img_w, max_dim / img_h)
        if scale <= 0:
            raise ValueError("Map too large to render")
        cell_size = max(1, int(cell_size * scale))
        img_w = width * cell_size
        img_h = height * cell_size

    bg_color = map_data.get("metadata", {}).get("background", "#2b2b2b")

    im = Image.new("RGBA", (img_w, img_h), bg_color)
    draw = ImageDraw.Draw(im)

    # draw grid lines
    grid_color = map_data.get("metadata", {}).get("gridColor", "#444444")
    for x in range(0, img_w + 1, cell_size):
        draw.line([(x, 0), (x, img_h)], fill=grid_color)
    for y in range(0, img_h + 1, cell_size):
        draw.line([(0, y), (img_w, y)], fill=grid_color)

    # Optional: draw named origin or map name
    name = map_data.get("name") or map_data.get("id") or "map"
    try:
        draw.text((6, 6), name, fill="#ffffff")
    except Exception:
        # text drawing is optional; Pillow default font may not be available
        pass

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    im.save(out_path, "PNG")
    print(f"Wrote map image to: {out_path} ({img_w}x{img_h}px)")


def find_map_file_by_id(map_id: str) -> str | None:
    candidate = os.path.join(DEFAULT_CONFIG_DIR, f"{map_id}.json")
    if os.path.exists(candidate):
        return candidate
    # fallback to config/<mapId>.json
    candidate2 = os.path.join("config", f"{map_id}.json")
    if os.path.exists(candidate2):
        return candidate2
    return None


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Generate PNG for a saved map JSON")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--map", help="map id (looks for config/maps/<id>.json)")
    g.add_argument("--file", help="path to map json file")
    p.add_argument("--out", help="output PNG path (default: assets/maps/<id>.png)")

    args = p.parse_args(argv)

    if args.file:
        if not os.path.exists(args.file):
            print(f"Map file not found: {args.file}")
            return 2
        map_data = load_map_json_from_file(args.file)
        map_id = map_data.get("id") or os.path.splitext(os.path.basename(args.file))[0]
    else:
        path = find_map_file_by_id(args.map)
        if not path:
            print(f"Map JSON for id '{args.map}' not found in {DEFAULT_CONFIG_DIR}")
            return 2
        map_data = load_map_json_from_file(path)
        map_id = args.map

    out_path = args.out or os.path.join(DEFAULT_OUTPUT_DIR, f"{map_id}.png")

    try:
        render_map_to_image(map_data, out_path)
    except Exception as exc:
        print("Failed to render map:", exc)
        return 3

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
