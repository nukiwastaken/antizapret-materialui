"""Extract the supplied artwork's exterior white background, then build macOS icons."""

import argparse
from collections import deque
from pathlib import Path
import subprocess
import tempfile

from PIL import Image


def extract(source):
    image = Image.open(source).convert("RGBA")
    width, height = image.size
    pixels = image.load()
    exterior = set()
    queue = deque(
        [(x, y) for x in range(width) for y in (0, height - 1)]
        + [(x, y) for y in range(height) for x in (0, width - 1)]
    )
    while queue:
        x, y = queue.popleft()
        if (x, y) in exterior:
            continue
        rgb = pixels[x, y][:3]
        if min(rgb) < 240 or max(rgb) - min(rgb) > 15:
            continue
        exterior.add((x, y))
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in exterior:
                queue.append((nx, ny))

    # Unmatte only neutral edge pixels touching the exterior, preserving white
    # highlights and globe lines enclosed by the artwork's black outline.
    fringe = set()
    for x, y in exterior:
        pixels[x, y] = (0, 0, 0, 0)
        for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= nx < width and 0 <= ny < height and (nx, ny) not in exterior:
                fringe.add((nx, ny))
    for x, y in fringe:
        rgb = pixels[x, y][:3]
        if max(rgb) - min(rgb) <= 15:
            pixels[x, y] = (0, 0, 0, 255 - min(rgb))
    bbox = image.getbbox()
    if not bbox:
        raise ValueError("No artwork found")
    image = image.crop(bbox)
    canvas = Image.new("RGBA", (image.width + 32, image.height + 32))
    canvas.paste(image, (16, 16))
    return canvas


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    args = parser.parse_args()
    assets = Path(__file__).resolve().parents[1] / "assets"
    assets.mkdir(exist_ok=True)
    logo = extract(args.source)
    logo.save(assets / "netbridge.png")
    artwork = logo.copy()
    artwork.thumbnail((860, 860), Image.Resampling.LANCZOS)
    icon = Image.new("RGBA", (1024, 1024))
    icon.paste(artwork, ((1024 - artwork.width) // 2, (1024 - artwork.height) // 2))
    icon.save(assets / "netbridge-icon.png")
    with tempfile.TemporaryDirectory() as temp:
        iconset = Path(temp) / "netbridge.iconset"
        iconset.mkdir()
        for size in (16, 32, 128, 256, 512):
            for scale in (1, 2):
                suffix = "@2x" if scale == 2 else ""
                icon.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(
                    iconset / f"icon_{size}x{size}{suffix}.png"
                )
        subprocess.run(
            ["/usr/bin/iconutil", "-c", "icns", str(iconset), "-o", str(assets / "netbridge.icns")],
            check=True,
        )
    print(f"Saved transparent logo {logo.size} and macOS icon in {assets}")


if __name__ == "__main__":
    main()
