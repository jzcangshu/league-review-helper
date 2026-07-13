---
name: league-review-prep
description: Prepare new schools for youth league application review and finish completed-school exports. Use when Codex needs to onboard a new school, create empty audit-result TXT files under the review-result root from PDF filenames, compare Excel roster names against PDF files, report missing or suspicious names, register the PDF folder for the local review-web app, or write a completed school's TXT audit results back into the roster Excel with missing materials marked in red.
---

# League Review Prep

The WebUI is the primary beginner workflow and can independently import a PDF folder and Excel roster, compare names, create review TXT files, review PDFs, and write results back to Excel. Use this optional skill when the user explicitly asks Codex to automate the same preparation or completed-school export from the command line.

## Workflow

1. Identify the school folder, roster Excel file, and PDF application folder.
2. Run `scripts/prepare_school_review.py`.
3. Read the Markdown report it prints.
4. Report to the user:
   - how many empty audit-result TXT files were created
   - names only in Excel
   - names only in PDF/materials
   - suspicious name-shape pairs
   - whether the folder was registered for `review-web`

Keep the selected PDF folder's basename as the school name unless the user explicitly provides another name. Do not infer a school name from parent folders.

## Recommended Command

From the workspace root:

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --update-web-sources
```

If automatic discovery chooses the wrong file or folder, rerun with explicit paths:

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school "学校名" --excel "学校/名单.xlsx" --pdf-dir "学校/资料目录" --update-web-sources
```

Use the bundled Python from `load_workspace_dependencies` when available. The script requires `openpyxl`.

## Completed Review Export

When the user says a school is fully reviewed, write the school's `审核结果/<学校名>/*_审核结果.txt` files back into the existing Excel review-result column.

If Codex is running the write-back, inspect the roster workbook headers first and decide the exact target column name. Then pass that header with `--result-column`. Do not rely on blind/default column creation. If no suitable existing column is present, stop and report it to the user.

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --write-excel --result-column "入团志愿书问题备注"
```

Target-column choice order:

1. Prefer the exact header `问题备注`.
2. Otherwise use the exact header `问题`.
3. Otherwise use the only header containing `问题`.

The script applies the same priority when `--result-column` is omitted for manual runs, but it never creates a missing column. Multiple candidates at the same priority are treated as ambiguous; rerun with `--result-column`.

The write-back mode automatically uses high-confidence fuzzy matches when the Excel name and TXT-result name have the same length, the same first character, exactly one differing character, and only one candidate. This is intended for obvious homophone/near-shape typos such as `李明/李铭` or `周晴/周睛`. Every fuzzy or alias write must still be reported in the Markdown output so the user can review it.

If there are confirmed name-shape differences that are ambiguous or not captured by this rule, pass them explicitly:

```powershell
python codex-skills/league-review-prep/scripts/prepare_school_review.py --school-dir "学校文件夹" --write-excel --result-column "入团志愿书问题备注" --alias "Excel姓名=审核结果姓名"
```

Rows without a matching audit-result TXT are written as red `无资料`. Empty TXT files are not enough to prove that a review is complete: only names recorded in `审核结果/<学校名>/.review-status.json` are treated as reviewed with no issues and written as blank cells. Empty TXT files without that explicit status are written as orange `未审核` so pre-created placeholders cannot be mistaken for completed reviews.

The review web app maintains `.review-status.json` automatically. Non-empty TXT content remains backward-compatible and is always treated as reviewed. Do not manually mark every pre-created empty TXT as reviewed.

## Output Convention

The script creates:

- `审核结果/<学校名>/<人名>_审核结果.txt`
- `审核结果/<学校名>/.review-status.json` for explicit reviewed/no-issue state
- optional `review-web/sources.json` entry when `--update-web-sources` is used

Review TXT files are created only under `审核结果/<学校名>`. Existing review TXT files are never overwritten.

## Name Rules

Use PDF filenames only. Do not open or parse PDF content.

Normalize file names by removing common labels such as `入团申请书`, `入团志愿书`, `申请书`, `志愿书`, `审核结果`, `转PDF`, class prefixes such as `803班`, separators, and trailing six-digit export suffixes.

Treat suspicious name-shape pairs as a report item only during pre-review preparation. Do not change Excel names or rename files in preparation mode.

For Excel write-back, use exact names first. Then automatically use high-confidence unique fuzzy matches: same length, same first character, exactly one differing character, and only one candidate. Use explicit `--alias` mappings for confirmed differences outside that rule. All non-exact writes, including high-confidence fuzzy writes, must be reported. If multiple TXT names are plausible or confidence is low, do not guess; mark the Excel row red as `无资料` and report the candidates.

## Safety

Do not delete user materials. If temporary logs or accidental cache files are created, remove only clearly generated runtime/cache files after confirming their paths stay inside the workspace or temp directory.
