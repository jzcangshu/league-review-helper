import argparse
import json
from pathlib import Path

import fitz


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--max-width", type=int, default=168)
    parser.add_argument("--max-height", type=int, default=224)
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    pages = []
    with fitz.open(args.pdf) as document:
        for page_number, page in enumerate(document, start=1):
            scale = min(args.max_width / page.rect.width, args.max_height / page.rect.height)
            pixmap = page.get_pixmap(
                matrix=fitz.Matrix(scale, scale),
                colorspace=fitz.csRGB,
                alpha=False,
            )
            file_name = f"{page_number}.png"
            pixmap.save(str(output_dir / file_name))
            pages.append({
                "page": page_number,
                "width": pixmap.width,
                "height": pixmap.height,
                "fileName": file_name,
            })
    print(json.dumps({"pages": pages}, ensure_ascii=False))


if __name__ == "__main__":
    main()
