# Problems Cleaner

A VS Code extension that helps clear stale entries in the **Problems** pane by refreshing diagnostic providers and optionally restarting the Extension Host.

## Why this exists

VS Code diagnostics are owned by the extension or task that created them. A third-party extension cannot directly mutate another extension's `DiagnosticCollection`. This extension therefore uses the practical workaround users actually need:

- soft-refresh known diagnostic providers such as TypeScript, ESLint, and Stylelint;
- poke visible documents so language servers re-check current files;
- detect diagnostics that point at missing files;
- provide a one-click hard refresh via **Restart Extension Host** or **Reload Window**;
- add a Problems title button and status-bar button for quick access.

## Commands

- `Problems Cleaner: Refresh Problems`
- `Problems Cleaner: Hard Refresh Problems (Restart Extension Host)`
- `Problems Cleaner: Show Diagnostics Report`

## Settings

```jsonc
{
  "problemsCleaner.providerRefreshCommands": [
    "typescript.restartTsServer",
    "eslint.restart",
    "stylelint.restart"
  ],
  "problemsCleaner.hardRefreshMode": "restartExtensionHost",
  "problemsCleaner.autoRefreshOnFileDelete": true,
  "problemsCleaner.showStatusBarButton": true
}
```

Add more provider restart commands if your stack has them.

## Development

```bash
npm install
npm run compile
npx vsce package --no-dependencies
```

Then install the generated `.vsix` file in VS Code.
