# Change Log

## 0.1.2

- Fixed diagnostics-change updates so the status bar and dashboard refresh when VS Code diagnostics change.
- Kept the manual refresh fallback aligned with the documented `openProblemsAfterRefresh: false` default.

## 0.1.1

- Added cancellable refresh operations with a **Cancel Operation** command and status-bar hover cancel link while work is running.
- Added the **Settings** action to the status-bar hover UI so provider setup is always reachable from hover.
- Prevented overlapping Problems Cleaner refresh operations from running at the same time.
- Removed redundant generated activation events from the extension manifest.
- Added the missing Problems Cleaner view icon contribution.

## 0.1.0

- Initial release of Problems Cleaner.
- Manual refresh for stale VS Code Problems diagnostics.
- Provider setup dashboard with discovered refresh/restart commands.
- Per-provider refresh and hard-refresh fallback actions.
- Diagnostics report with severity, source, and missing-file counts.
- Theme-aware Activity Bar, command, and Marketplace icons.
- Manual-only behavior by default: no workspace file watcher auto-refresh and no Problems panel focus stealing unless explicitly enabled.
