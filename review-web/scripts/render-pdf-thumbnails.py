import argparse
import json
from pathlib import Path

import pypdfium2 as pdfium


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
    document = pdfium.PdfDocument(args.pdf)
    try:
        for page_number in range(1, len(document) + 1):
            page = document[page_number - 1]
            width, height = page.get_size()
            scale = min(args.max_width / width, args.max_height / height)
            bitmap = page.render(scale=scale)
            image = bitmap.to_pil().convert("RGB")
            file_name = f"{page_number}.png"
            image.save(output_dir / file_name, format="PNG")
            pages.append({
                "page": page_number,
                "width": image.width,
                "height": image.height,
                "fileName": file_name,
            })
            bitmap.close()
            page.close()
    finally:
        document.close()
    print(json.dumps({"pages": pages}, ensure_ascii=False))


if __name__ == "__main__":
    main()
