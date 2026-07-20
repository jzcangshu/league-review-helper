import argparse
import contextlib
import json
import os
import sys

os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

with contextlib.redirect_stdout(sys.stderr):
    import cv2
    import numpy as np
    import pypdfium2 as pdfium
    from paddleocr import TextDetection, TextRecognition


def order_points(points: np.ndarray) -> np.ndarray:
    ordered = np.zeros((4, 2), dtype=np.float32)
    sums = points.sum(axis=1)
    differences = np.diff(points, axis=1).reshape(-1)
    ordered[0] = points[np.argmin(sums)]
    ordered[2] = points[np.argmax(sums)]
    ordered[1] = points[np.argmin(differences)]
    ordered[3] = points[np.argmax(differences)]
    return ordered


def crop_text_line(image: np.ndarray, polygon: list[list[int]]) -> np.ndarray:
    points = order_points(np.asarray(polygon, dtype=np.float32))
    width = max(
        int(np.linalg.norm(points[1] - points[0])),
        int(np.linalg.norm(points[2] - points[3])),
        2,
    )
    height = max(
        int(np.linalg.norm(points[3] - points[0])),
        int(np.linalg.norm(points[2] - points[1])),
        2,
    )
    target = np.asarray([[0, 0], [width - 1, 0], [width - 1, height - 1], [0, height - 1]], dtype=np.float32)
    matrix = cv2.getPerspectiveTransform(points, target)
    return cv2.warpPerspective(image, matrix, (width, height), borderMode=cv2.BORDER_REPLICATE)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--scale", type=float, default=3.5)
    args = parser.parse_args()

    with contextlib.redirect_stdout(sys.stderr):
        detector = TextDetection(model_name="PP-OCRv6_small_det", engine="onnxruntime")
        recognizer = TextRecognition(model_name="PP-OCRv6_tiny_rec", engine="onnxruntime")

    document = pdfium.PdfDocument(args.pdf)
    output_pages = []
    for page_index in range(len(document)):
        page = document[page_index]
        bitmap = page.render(scale=args.scale)
        image = np.asarray(bitmap.to_pil().convert("RGB"))

        with contextlib.redirect_stdout(sys.stderr):
            detection = list(detector.predict(input=image, batch_size=1))[0].json["res"]
        polygons = [
            polygon for polygon, score in zip(detection.get("dt_polys", []), detection.get("dt_scores", []))
            if float(score) >= 0.45
        ]
        polygons.sort(key=lambda polygon: (min(point[1] for point in polygon), min(point[0] for point in polygon)))
        crops = [crop_text_line(image, polygon) for polygon in polygons]

        with contextlib.redirect_stdout(sys.stderr):
            recognition = list(recognizer.predict(input=crops, batch_size=8)) if crops else []
        lines = []
        for polygon, result in zip(polygons, recognition):
            payload = result.json["res"]
            text = str(payload.get("rec_text") or "").strip()
            if not text:
                continue
            left = min(point[0] for point in polygon)
            top = min(point[1] for point in polygon)
            right = max(point[0] for point in polygon)
            bottom = max(point[1] for point in polygon)
            lines.append({
                "text": text,
                "confidence": round(float(payload.get("rec_score") or 0), 4),
                "words": [{
                    "text": text,
                    "x": round(float(left), 2),
                    "y": round(float(top), 2),
                    "width": round(float(right - left), 2),
                    "height": round(float(bottom - top), 2),
                }],
            })

        output_pages.append({
            "page": page_index + 1,
            "width": int(image.shape[1]),
            "height": int(image.shape[0]),
            "textAngle": None,
            "lines": lines,
        })
        bitmap.close()
        page.close()

    document.close()

    print(json.dumps({
        "engine": "PP-OCRv6_small_det+PP-OCRv6_tiny_rec",
        "language": "zh-Hans-CN",
        "pages": output_pages,
    }, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
