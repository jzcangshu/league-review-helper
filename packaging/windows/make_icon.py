from pathlib import Path
import sys

from PIL import Image



def main() -> None:
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    image = Image.open(source).convert("RGBA")
    bounds = image.getbbox()
    if bounds:
        image = image.crop(bounds)
    canvas = Image.new("RGBA", (256, 256), (0, 0, 0, 0))
    image.thumbnail((244, 244), Image.Resampling.LANCZOS)
    canvas.alpha_composite(image, ((256 - image.width) // 2, (256 - image.height) // 2))
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])


if __name__ == "__main__":
    main()
