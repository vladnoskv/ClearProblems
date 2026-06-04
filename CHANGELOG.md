# Change Log

## 0.1.3

- Added **Clear Problems** command that kills stalled task processes and re-executes allowed tasks to purge stale problemMatcher diagnostics.
- Added **Settings** interactive webview to configure all extension options visually (provider commands, cleared tasks, behavior toggles).
- Added `problemsCleaner.clearedTasks` setting to control which tasks Clear Problems is allowed to restart.
- Added `problemsCleaner.refreshTasks` setting to optionally re-execute tasks during Refresh Problems.
- Dashboard now shows which diagnostic tasks are in the clearedTasks allow list with visual indicators.
- Fixed background/watch task handling so Clear Problems and Refresh Problems don't hang on tasks that never exit.
- Tightened task-to-diagnostic matching to prefer running tasks and use word-boundary matching for non-running tasks.

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
