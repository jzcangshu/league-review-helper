from pathlib import Path
import struct
import sys
import zlib


def png(width: int, height: int, pixels: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    rows = b"".join(b"\x00" + pixels[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def make_rgba(size: int) -> bytes:
    data = bytearray()
    radius = size * 0.22
    for y in range(size):
        for x in range(size):
            dx = max(radius - x, 0, x - (size - 1 - radius))
            dy = max(radius - y, 0, y - (size - 1 - radius))
            inside = dx * dx + dy * dy <= radius * radius
            ratio = y / max(size - 1, 1)
            data.extend((round(45 - 20 * ratio), round(145 - 35 * ratio), round(245 - 10 * ratio), 255 if inside else 0))
    return bytes(data)


def main() -> None:
    output = Path(sys.argv[1])
    images = []
    for size in (16, 32, 48, 64, 128, 256):
        payload = png(size, size, make_rgba(size))
        images.append((size, payload))
    header = struct.pack("<HHH", 0, 1, len(images))
    entries = bytearray()
    offset = 6 + 16 * len(images)
    for size, payload in images:
        encoded = 0 if size == 256 else size
        entries.extend(struct.pack("<BBBBHHII", encoded, encoded, 0, 0, 1, 32, len(payload), offset))
        offset += len(payload)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(header + bytes(entries) + b"".join(payload for _, payload in images))


if __name__ == "__main__":
    main()
