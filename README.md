# Problems Cleaner

A VS Code extension that helps clear stale entries in the **Problems** pane by refreshing diagnostic providers and optionally restarting the Extension Host.

Problems Cleaner is manual by design. It does not watch the whole workspace or auto-refresh in the background, so it avoids CPU churn and does not steal focus from your current editor or terminal.

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
- include theme-aware PNG command/menu icons and a package PNG icon;
- provide a one-click hard refresh via **Restart Extension Host** or **Reload Window**;
- add Problems toolbar buttons and a status-bar button for quick access.

## Important limitations

VS Code diagnostics are owned by the extension or task that published them. Problems Cleaner cannot directly delete diagnostics from another extension's `DiagnosticCollection`. It can request refresh/restart commands exposed by those providers and can restart the Extension Host when a provider is stuck.

VS Code also does not expose a public API to restart only one arbitrary extension. Provider-specific **Restart** first runs that provider's configured refresh/restart commands, then offers Extension Host restart as the hard-refresh fallback.

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
- Hover the status-bar item for quick refresh/report/hard-refresh links. Provider setup is intentionally handled in the dashboard, not from hover UI.

Refreshes only run when the user requests them. There is no file watcher auto-refresh path.
Manual refresh does not open or focus the Problems panel unless `problemsCleaner.openProblemsAfterRefresh` is explicitly enabled.

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
  "problemsCleaner.showStatusBarButton": true,
  "problemsCleaner.openProblemsAfterRefresh": false
}
```

Provider selections are saved by the extension and managed from the dashboard, not by editing `settings.json`.

## Icons

- `resources/icon.png` is the extension/package icon.
- `resources/icons/problems-cleaner-light.png` is used for command/menu icons in light themes.
- `resources/icons/problems-cleaner-dark.png` is used for command/menu icons in dark themes.
- `resources/problems-cleaner.svg` is the Activity Bar icon and uses `currentColor` so VS Code can theme it.

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

## Publishing

The package includes Marketplace metadata in `package.json`: publisher, repository, bugs, homepage, icon, gallery banner, categories, and keywords.

Before publishing:

```bash
npm run compile
npm run vsix
npx vsce publish
```

Publishing requires a Marketplace publisher account and a `vsce` Personal Access Token.
