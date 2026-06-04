# Problems Cleaner

A VS Code extension that helps clear stale entries in the **Problems** pane by refreshing diagnostic providers and optionally restarting the Extension Host.

Problems Cleaner is manual by design. It does not watch the whole workspace or auto-refresh in the background, so it avoids CPU churn and does not steal focus from your current editor or terminal.
The status bar and dashboard still update when VS Code publishes new diagnostics, so counts stay current without running refresh commands automatically.

## Why this exists

VS Code diagnostics are owned by the extension or task that created them. A third-party extension cannot directly mutate another extension's `DiagnosticCollection`. This extension therefore uses the practical workaround users actually need:

- soft-refresh known diagnostic providers such as TypeScript, ESLint, and Stylelint;
- poke visible documents so language servers re-check current files;
- detect diagnostics that point at missing files;
- show stale-file paths and diagnostic sources in a report;
- keep the status bar count updated as diagnostics change;
- add a **Problems Cleaner** Activity Bar view with refresh, report, and hard-refresh buttons;
- run a first-install setup flow that auto-detects likely diagnostic/lint extensions;
- let you right-click an installed extension and add its refresh/restart commands to Problems Cleaner;
- manage refreshed extensions and commands from a visual dashboard;
- refresh one configured provider from the dashboard, command palette, or Problems row context action when VS Code exposes row context;
- cancel in-flight Problems Cleaner refresh operations from the progress notification or status-bar hover UI;
- include theme-aware PNG command/menu icons and a package PNG icon;
- provide a one-click hard refresh via **Restart Extension Host** or **Reload Window**;
- add Problems toolbar buttons and a status-bar button for quick access;
- **Clear Problems** — kill stalled task processes and re-execute allowed tasks to purge stale problemMatcher diagnostics;
- detect which workspace tasks own current diagnostics and show allowed/blocked status in the dashboard;
- interactive **Settings** webview to configure all extension options visually without editing JSON.

## Clear Problems — fixing stale task diagnostics

Task diagnostics from `problemMatchers` are owned by VS Code's internal task system, not by any extension. When you run a task (e.g. a compiler watch), fix the underlying error, and the file lines shift, old markers can persist at the old line numbers alongside fresh ones — producing duplicate problems.

The only way to clear task-owned diagnostics is to re-run the task. **Clear Problems** automates this:

1. Identifies which workspace tasks produced the current diagnostics
2. Terminates any currently-running instances of those tasks
3. Re-executes **only** tasks whose names appear in `problemsCleaner.clearedTasks`
4. Waits for fresh diagnostics to be published
5. Updates the dashboard and status bar

### Configuration

Set `problemsCleaner.clearedTasks` to the exact task names (from `tasks.json`) you want Clear Problems to manage:

```jsonc
{
  "problemsCleaner.clearedTasks": [
    "tsc: watch - tsconfig.json",
    "eslint: whole folder"
  ]
}
```

Leave the list empty to prevent Clear Problems from restarting any tasks (it will still show which tasks own diagnostics in the dashboard).

Enable `problemsCleaner.refreshTasks` to also see task diagnostics in the dashboard and optionally have `Refresh Problems` re-execute all matching tasks.

### Workflow example

1. A TypeScript watch task reports an error on line 42
2. You fix the error, which shifts the file — old marker stays at line 42, new marker appears at line 39
3. Run **Clear Problems** from the command palette, dashboard, or Problems panel toolbar
4. The watch task is killed, restarted, and fresh diagnostics replace the stale ones
5. The Problems pane now shows only the actual current state

## Important limitations

VS Code diagnostics are owned by the extension or task that published them. Problems Cleaner cannot directly delete diagnostics from another extension's `DiagnosticCollection`. It can request refresh/restart commands exposed by those providers and can restart the Extension Host when a provider is stuck.

VS Code also does not expose a public API to restart only one arbitrary extension. Provider-specific **Restart** first runs that provider's configured refresh/restart commands, then offers Extension Host restart as the hard-refresh fallback.

Cancellation is cooperative. Problems Cleaner stops before starting the next safe step and avoids showing completion messages after cancellation, but it cannot forcibly interrupt a refresh command that is already running inside another extension.

## Commands

- `Problems Cleaner: Refresh Problems`
- `Problems Cleaner: Clear Problems`
- `Problems Cleaner: Settings`
- `Problems Cleaner: Hard Refresh Problems (Restart Extension Host)`
- `Problems Cleaner: Cancel Operation`
- `Problems Cleaner: Show Diagnostics Report`
- `Problems Cleaner: Setup Diagnostic Providers`
- `Problems Cleaner: Open Dashboard`
- `Problems Cleaner: Add to Problems Refresh`
- `Problems Cleaner: Refresh Provider for Problem`
- `Problems Cleaner: Restart Provider for Problem`

## UI

- Open the **Problems Cleaner** icon in the Activity Bar for the main dashboard.
- Use **Refresh Problems** to request provider restarts and diagnostics recomputation.
- Use **Show Diagnostics Report** for a detailed source and stale-file report.
- Use **Hard Refresh** when diagnostics remain stuck after a soft refresh.
- Use **Clear Problems** to kill stalled task processes and re-execute allowed tasks, cleaning stale problemMatcher diagnostics.
- Use **Settings** to open the interactive settings editor where you can manage provider commands, cleared tasks, and behavior toggles without editing JSON.
- Use **Setup Providers** to scan installed extensions and add likely diagnostic providers.
- Use **Cancel Operation** from the progress notification or status-bar hover UI to stop an in-flight Problems Cleaner refresh at the next safe boundary.
- Use each provider's **Refresh** button to run only that provider's configured refresh/restart commands.
- Use each provider's **Restart** button when its diagnostics remain stale. VS Code's public API cannot restart only one extension; this action first refreshes that provider, then offers Extension Host restart as the available hard refresh.
- Right-click an extension in VS Code's Extensions view and choose **Problems Cleaner: Add to Problems Refresh**.
- Right-click a Problems row and choose **Problems Cleaner: Refresh Provider for Problem** if VS Code exposes the Problems row context menu in your build.
- Hover the status-bar item for quick refresh, report, settings, and hard-refresh links. A cancel link appears there while a Problems Cleaner operation is running.

Refreshes only run when the user requests them. There is no file watcher auto-refresh path.
Manual refresh does not open or focus the Problems panel unless `problemsCleaner.openProblemsAfterRefresh` is explicitly enabled.

## Settings

All settings can be configured through the interactive **Settings** webview (`Problems Cleaner: Settings`) or by editing `settings.json` directly.

```jsonc
{
  "problemsCleaner.providerRefreshCommands": [
    "typescript.restartTsServer",
    "eslint.restart",
    "stylelint.restart",
    "biome.restartServer",
    "svelte.restartLanguageServer",
    "python.analysis.restartLanguageServer"
  ],
  "problemsCleaner.hardRefreshMode": "restartExtensionHost",
  "problemsCleaner.showStatusBarButton": true,
  "problemsCleaner.openProblemsAfterRefresh": false,
  "problemsCleaner.refreshTasks": false,
  "problemsCleaner.clearedTasks": [
    "tsc: watch - tsconfig.json"
  ]
}
```
