#!/usr/bin/env python3
"""Prepare a new school folder for youth league PDF review."""

from __future__ import annotations

import argparse
import json
import re
import sys
from copy import copy
from dataclasses import dataclass
from difflib import SequenceMatcher
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.styles import Font


def clean(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "")).strip()


def locale_key(value: str) -> tuple[int, str]:
    return (len(value), value)


def extract_name(stem: str) -> str:
    value = clean(stem)
    value = re.sub(r"^转PDF[_\-\s]*", "", value, flags=re.I)
    value = re.sub(r"[_\-\s]*\d{6,}$", "", value)
    value = re.sub(r"^\d{3}\s*班?\s*", "", value)
    for token in ("入团申请书", "入团志愿书", "入团申请", "入团志愿", "申请书", "志愿书", "审核结果"):
        value = value.replace(token, "")
    value = re.sub(r"[\s_\-—－]+", "", value)
    return value.strip()


@dataclass(frozen=True)
class ExcelRoster:
    path: Path
    sheet: str
    header_row: int
    name_col: int
    names: list[str]


def find_roster_in_excel(path: Path) -> ExcelRoster | None:
    workbook = load_workbook(path, read_only=True, data_only=True)
    best: ExcelRoster | None = None
    for sheet in workbook.worksheets:
        for row in range(1, min(sheet.max_row, 15) + 1):
            headers = [clean(sheet.cell(row, column).value) for column in range(1, sheet.max_column + 1)]
            if "姓名" not in headers:
                continue
            name_col = headers.index("姓名") + 1
            names: list[str] = []
            for current_row in range(row + 1, sheet.max_row + 1):
                name = clean(sheet.cell(current_row, name_col).value)
                if name and name != "姓名":
                    names.append(name)
            roster = ExcelRoster(path, sheet.title, row, name_col, names)
            if best is None or len(roster.names) > len(best.names):
                best = roster
    return best


def discover_excel(workspace: Path, school_dir: Path | None, explicit: Path | None) -> ExcelRoster:
    if explicit:
        roster = find_roster_in_excel(explicit)
        if not roster:
            raise SystemExit(f"未在 Excel 中找到姓名列：{explicit}")
        return roster

    search_root = school_dir or workspace
    candidates: list[ExcelRoster] = []
    for path in search_root.rglob("*.xlsx"):
        if path.name.startswith("~$"):
            continue
        roster = find_roster_in_excel(path)
        if roster and roster.names:
            candidates.append(roster)
    if not candidates:
        raise SystemExit(f"未找到带姓名列的 Excel：{search_root}")
    candidates.sort(key=lambda item: len(item.names), reverse=True)
    return candidates[0]


def discover_pdf_dir(school_dir: Path | None, explicit: Path | None) -> Path:
    if explicit:
        return explicit
    if not school_dir:
        raise SystemExit("未提供 --pdf-dir 时必须提供 --school-dir。")

    candidates: list[tuple[int, Path]] = []
    for directory in [school_dir, *[path for path in school_dir.rglob("*") if path.is_dir()]]:
        count = len(list(directory.glob("*.pdf")))
        if count:
            candidates.append((count, directory))
    if not candidates:
        raise SystemExit(f"未找到 PDF 资料目录：{school_dir}")
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def suspicious_pairs(only_excel: list[str], only_pdf: list[str]) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    used_pdf: set[str] = set()
    for excel_name in only_excel:
        candidates: list[tuple[float, int, str]] = []
        for pdf_name in only_pdf:
            if pdf_name in used_pdf or len(excel_name) != len(pdf_name):
                continue
            same_positions = sum(1 for left, right in zip(excel_name, pdf_name) if left == right)
            if excel_name[0] == pdf_name[0] and same_positions == len(excel_name) - 1:
                ratio = SequenceMatcher(None, excel_name, pdf_name).ratio()
                candidates.append((ratio, same_positions, pdf_name))
        if candidates:
            candidates.sort(reverse=True)
            pdf_name = candidates[0][2]
            used_pdf.add(pdf_name)
            pairs.append((excel_name, pdf_name))
    return pairs


def is_confident_name_match(excel_name: str, result_name_value: str) -> bool:
    if excel_name == result_name_value:
        return True
    if not excel_name or not result_name_value or len(excel_name) != len(result_name_value):
        return False
    if excel_name[0] != result_name_value[0]:
        return False
    differing_positions = sum(1 for left, right in zip(excel_name, result_name_value) if left != right)
    if differing_positions != 1:
        return False
    return True


def find_confident_result_match(excel_name: str, results: dict[str, str], aliases: dict[str, str]) -> tuple[str | None, str]:
    if excel_name in aliases:
        return aliases[excel_name], "alias"
    if excel_name in results:
        return excel_name, "exact"

    candidates = [name for name in results if is_confident_name_match(excel_name, name)]
    if len(candidates) == 1:
        return candidates[0], "fuzzy"
    if len(candidates) > 1:
        return None, "ambiguous:" + "、".join(sorted(candidates, key=locale_key))
    return None, "missing"


def ensure_empty_file(path: Path) -> bool:
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")
    return True


def update_web_sources(workspace: Path, school: str, pdf_dir: Path) -> None:
    sources_path = workspace / "review-web" / "sources.json"
    if sources_path.exists():
        sources = json.loads(sources_path.read_text(encoding="utf-8"))
        if not isinstance(sources, list):
            sources = []
    else:
        sources = []

    relative_pdf_dir = str(pdf_dir.relative_to(workspace))
    next_sources = [
        source
        for source in sources
        if not (
            isinstance(source, dict)
            and (
                source.get("school") == school
                or str(source.get("folderRelativePath", "")).lower() == relative_pdf_dir.lower()
            )
        )
    ]
    next_sources.append({"school": school, "folderRelativePath": relative_pdf_dir})
    sources_path.parent.mkdir(parents=True, exist_ok=True)
    sources_path.write_text(json.dumps(next_sources, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_aliases(values: list[str]) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"别名格式应为 Excel姓名=审核结果姓名：{value}")
        excel_name, review_name = value.split("=", 1)
        aliases[clean(excel_name)] = clean(review_name)
    return aliases


def result_name(path: Path) -> str:
    stem = path.stem
    if stem.endswith("_审核结果"):
        stem = stem[: -len("_审核结果")]
    return extract_name(stem)


def load_review_results(review_dir: Path) -> dict[str, str]:
    if not review_dir.exists():
        return {}
    results: dict[str, str] = {}
    for path in sorted(review_dir.glob("*_审核结果.txt"), key=lambda item: item.name):
        results[result_name(path)] = path.read_text(encoding="utf-8-sig").strip()
    return results


def find_or_create_result_column(sheet, header_row: int) -> int:
    for column in range(1, sheet.max_column + 1):
        if clean(sheet.cell(header_row, column).value) == "入团志愿书问题备注":
            return column
    result_col = sheet.max_column + 1
    sheet.cell(header_row, result_col).value = "入团志愿书问题备注"
    return result_col


def red_font_from(cell) -> Font:
    font = copy(cell.font)
    font.color = "FF0000"
    return font


def normal_font_from(cell) -> Font:
    font = copy(cell.font)
    font.color = None
    return font


def write_reviews_to_excel(
    roster: ExcelRoster,
    review_dir: Path,
    aliases: dict[str, str],
    missing_text: str,
) -> dict[str, object]:
    results = load_review_results(review_dir)
    workbook = load_workbook(roster.path)
    sheet = workbook[roster.sheet]
    result_col = find_or_create_result_column(sheet, roster.header_row)

    written = 0
    blank = 0
    missing: list[str] = []
    ambiguous: list[tuple[str, str]] = []
    alias_used: list[tuple[str, str]] = []
    fuzzy_used: list[tuple[str, str]] = []
    used_results: set[str] = set()

    for row in range(roster.header_row + 1, sheet.max_row + 1):
        excel_name = clean(sheet.cell(row, roster.name_col).value)
        if not excel_name:
            continue
        source_name, match_kind = find_confident_result_match(excel_name, results, aliases)
        cell = sheet.cell(row, result_col)

        if source_name and source_name in results:
            content = results[source_name]
            cell.value = content or None
            cell.font = normal_font_from(cell)
            used_results.add(source_name)
            if content:
                written += 1
            else:
                blank += 1
            if match_kind == "alias":
                alias_used.append((excel_name, source_name))
            elif match_kind == "fuzzy":
                fuzzy_used.append((excel_name, source_name))
        else:
            cell.value = missing_text
            cell.font = red_font_from(cell)
            if match_kind.startswith("ambiguous:"):
                ambiguous.append((excel_name, match_kind.split(":", 1)[1]))
            else:
                missing.append(excel_name)

    workbook.save(roster.path)
    unused_results = sorted(set(results) - used_results, key=locale_key)
    return {
        "result_col": result_col,
        "written": written,
        "blank": blank,
        "missing": missing,
        "ambiguous": ambiguous,
        "alias_used": alias_used,
        "fuzzy_used": fuzzy_used,
        "unused_results": unused_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", default=".", help="workspace root, default: current directory")
    parser.add_argument("--school", help="school display name")
    parser.add_argument("--school-dir", help="school root folder; used for auto-discovery")
    parser.add_argument("--excel", help="explicit roster Excel path")
    parser.add_argument("--pdf-dir", help="explicit PDF folder")
    parser.add_argument("--review-root", default="审核结果", help="review result root folder")
    parser.add_argument("--update-web-sources", action="store_true", help="register folder in review-web/sources.json")
    parser.add_argument("--write-excel", action="store_true", help="write completed review TXT results into the roster Excel")
    parser.add_argument("--alias", action="append", default=[], help="confirmed name mapping, format: Excel姓名=审核结果姓名")
    parser.add_argument("--missing-text", default="无资料", help="text written in red when no matching review result exists")
    args = parser.parse_args()

    workspace = Path(args.workspace).resolve()
    school_dir = (workspace / args.school_dir).resolve() if args.school_dir else None
    excel_path = (workspace / args.excel).resolve() if args.excel else None
    pdf_dir_arg = (workspace / args.pdf_dir).resolve() if args.pdf_dir else None

    roster = discover_excel(workspace, school_dir, excel_path)
    school = args.school or (school_dir.name if school_dir else roster.path.parent.name)
    review_dir = (workspace / args.review_root / school).resolve()

    if args.write_excel:
        aliases = parse_aliases(args.alias)
        write_report = write_reviews_to_excel(roster, review_dir, aliases, args.missing_text)
        print(f"# {school} 审核结果回写报告")
        print()
        print(f"- Excel: {roster.path.relative_to(workspace)}")
        print(f"- 工作表: {roster.sheet}，姓名表头行: {roster.header_row}")
        print(f"- 审核结果目录: {review_dir.relative_to(workspace)}")
        print(f"- 写入非空审核结果: {write_report['written']}；写入空结果: {write_report['blank']}")
        print(f"- 无资料红字标记: {len(write_report['missing'])}")
        alias_used = write_report["alias_used"]
        fuzzy_used = write_report["fuzzy_used"]
        mismatch_used = [*alias_used, *fuzzy_used]
        print("- 姓名字形不一致写入: " + ("、".join(f"{left}←{right}" for left, right in mismatch_used) if mismatch_used else "无"))
        if alias_used:
            print("- 使用确认别名: " + "、".join(f"{left}←{right}" for left, right in alias_used))
        if fuzzy_used:
            print("- 高置信模糊写入: " + "、".join(f"{left}←{right}" for left, right in fuzzy_used))
        ambiguous = write_report["ambiguous"]
        if ambiguous:
            print("- 模糊匹配多候选，已按无资料标记: " + "、".join(f"{left}←{right}" for left, right in ambiguous))
        missing = write_report["missing"]
        print("- 无资料名单: " + ("、".join(missing) if missing else "无"))
        unused_results = write_report["unused_results"]
        print("- 未写入的审核结果TXT: " + ("、".join(unused_results) if unused_results else "无"))
        return 0

    pdf_dir = discover_pdf_dir(school_dir, pdf_dir_arg)
    pdf_files = sorted(pdf_dir.glob("*.pdf"), key=lambda path: path.name)
    pdf_names = [extract_name(path.stem) for path in pdf_files]
    pdf_name_set = set(pdf_names)
    excel_name_set = set(roster.names)

    created_reviews = 0
    existing_reviews = 0
    for pdf_path, student_name in zip(pdf_files, pdf_names):
        if not student_name:
            continue
        review_path = review_dir / f"{student_name}_审核结果.txt"
        if ensure_empty_file(review_path):
            created_reviews += 1
        else:
            existing_reviews += 1

    if args.update_web_sources:
        update_web_sources(workspace, school, pdf_dir)

    only_excel = [name for name in roster.names if name not in pdf_name_set]
    only_pdf = sorted(pdf_name_set - excel_name_set, key=locale_key)
    pairs = suspicious_pairs(only_excel, only_pdf)

    print(f"# {school} 审核前准备报告")
    print()
    print(f"- Excel: {roster.path.relative_to(workspace)}")
    print(f"- 工作表: {roster.sheet}，姓名表头行: {roster.header_row}")
    print(f"- PDF目录: {pdf_dir.relative_to(workspace)}")
    print(f"- 审核结果目录: {review_dir.relative_to(workspace)}")
    print(f"- 名单人数: {len(roster.names)}；PDF人数: {len(pdf_names)}")
    print(f"- 新建审核结果TXT: {created_reviews}；已有: {existing_reviews}")
    if args.update_web_sources:
        print("- review-web导入配置: 已更新")
    print()
    print("## 核对结果")
    print()
    print("只在名单出现：" + ("、".join(only_excel) if only_excel else "无"))
    print()
    print("只在资料出现：" + ("、".join(only_pdf) if only_pdf else "无"))
    print()
    print("疑似姓名字形不一致：" + ("、".join(f"{left}/{right}" for left, right in pairs) if pairs else "无"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
