# Windows Offline Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and publish a professional Windows 10/11 x64 offline installer that starts without preinstalled development tools or first-run dependency downloads.

**Architecture:** Keep the existing local Node.js web service and browser UI, but package a fixed Node runtime, production dependencies, a relocatable Python OCR runtime, and the OCR models. A small native Windows launcher starts the hidden service, reuses an existing instance, opens the browser, and reports startup errors. Inno Setup installs per-user, creates shortcuts and an uninstaller, and records version metadata.

**Tech Stack:** PowerShell, Node.js 22, Python 3.11, Inno Setup 6, .NET Framework launcher, Node test runner.

---

### Task 1: Add relocatable OCR runtime support

**Files:**
- Modify: `review-web/lib/ocr-service.js`
- Modify: `review-web/lib/thumbnail-service.js`
- Test: `review-web/test/offline-runtime.test.js`

**Steps:**
1. Add failing tests for an explicitly configured packaged Python executable.
2. Run the targeted tests and confirm they fail.
3. Resolve `REVIEW_OCR_RUNTIME_PYTHON` before the legacy virtual environment.
4. Run the targeted and complete test suites.
5. Commit the runtime support.

### Task 2: Add native launcher and installer sources

**Files:**
- Create: `packaging/windows/LeagueReviewHelperLauncher.cs`
- Create: `packaging/windows/installer.iss`
- Create: `packaging/windows/make_icon.py`
- Create: `packaging/windows/build-offline-installer.ps1`
- Create: `packaging/windows/THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`
- Test: `review-web/test/windows-installer-contract.test.js`

**Steps:**
1. Add failing installer contract tests.
2. Implement a hidden launcher with single-instance health reuse and error reporting.
3. Define a per-user Inno Setup installer with shortcuts and uninstaller metadata.
4. Add a reproducible build script that prepares fixed runtimes and models.
5. Add third-party notices and architecture requirements.
6. Run contract tests and commit.

### Task 3: Build the complete offline payload

**Files:**
- Build output: `dist/LeagueReviewHelper-1.2.0-Windows-x64-Offline-Setup.exe`

**Steps:**
1. Prepare the production Node dependency tree.
2. Prepare a relocatable Python 3.11 runtime and install pinned OCR dependencies.
3. Preload the OCR models from the included sample PDF.
4. Generate the application icon and compile the native launcher.
5. Compile the Inno Setup installer.
6. Record size and SHA-256.

### Task 4: Validate on an isolated installation

**Files:**
- Test output: ignored installation verification directory.

**Steps:**
1. Install silently to an isolated per-user directory.
2. Start with Node, Python and network access removed from the test environment.
3. Verify the health endpoint, main page, PDF thumbnails and OCR endpoint.
4. Verify shortcuts/uninstall registration metadata.
5. Run all automated tests.

### Task 5: Version, document and publish

**Files:**
- Modify: `review-web/package.json`
- Modify: `review-web/package-lock.json`
- Modify: `README.md`

**Steps:**
1. Update the version to 1.2.0 and document the offline installer.
2. Run release checks and verify no private data or secrets are staged.
3. Commit, push `main`, and create GitHub Release v1.2.0 with the installer asset.
4. Verify the tag, release asset size and SHA-256.
5. Report temporary build artifacts that remain subject to workspace deletion restrictions.
