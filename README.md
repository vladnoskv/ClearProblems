# Problems Cleaner

A VS Code extension that helps clear stale entries in the **Problems** pane by refreshing diagnostic providers and optionally restarting the Extension Host.

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
- provide a one-click hard refresh via **Restart Extension Host** or **Reload Window**;
- add Problems toolbar buttons and a status-bar button for quick access.

## Commands

- `Problems Cleaner: Refresh Problems`
- `Problems Cleaner: Hard Refresh Problems (Restart Extension Host)`
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
- Use **Setup Providers** to scan installed extensions and add likely diagnostic providers.
- Use each provider's **Refresh** button to run only that provider's configured refresh/restart commands.
- Use each provider's **Restart** button when its diagnostics remain stale. VS Code's public API cannot restart only one extension; this action first refreshes that provider, then offers Extension Host restart as the available hard refresh.
- Right-click an extension in VS Code's Extensions view and choose **Problems Cleaner: Add to Problems Refresh**.
- Right-click a Problems row and choose **Problems Cleaner: Refresh Provider for Problem** if VS Code exposes the Problems row context menu in your build.
- Hover the status-bar item for quick command links. VS Code's public extension API supports Markdown tooltips there, not the same private rich hover surface used by some built-in/Copilot UI.

Refreshes only run when the user requests them. There is no file watcher auto-refresh path.

## Settings

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
  "problemsCleaner.showStatusBarButton": true
}
```

Provider selections are saved by the extension and managed from the dashboard, not by editing `settings.json`.

## Development

```bash
npm install
npm run compile
npm run vsix
```

Then install `dist/vscode-problems-cleaner.vsix` in VS Code:

```bash
code --install-extension dist/vscode-problems-cleaner.vsix
```
