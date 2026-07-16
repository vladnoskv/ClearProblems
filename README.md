# Problems Cleaner

Problems Cleaner helps remove stale entries from VS Code’s Problems view without immediately reloading the whole window.

It works with the way VS Code diagnostics are owned: the extension that creates a diagnostic must refresh or replace it. Problems Cleaner finds the likely owner, runs only the provider actions you approve, and gives you a controlled fallback when a provider is stuck.

## Safe by default

Clicking **Refresh Problems** is intentionally low-impact:

- It does not restart the Extension Host.
- It does not reload the VS Code window.
- It does not open editors or focus the Problems view unless you enable that setting.
- It does not run workspace tasks unless you enable task refresh.
- It runs no provider commands until you configure them.
- When provider commands are configured, it runs only commands matching current diagnostic sources by default.

The **Restart Extension Host** action is separate and always asks for confirmation.

## Get started

1. Open the **Problems Cleaner** view from the Activity Bar.
2. Select **Settings**.
3. Add refresh commands for providers you use, such as TypeScript or ESLint.
4. Leave **Only refresh providers matching current diagnostics** enabled.
5. Use **Refresh Problems** for a normal cleanup.
6. Use **Restart Extension Host** only when the provider remains stuck.

You can also choose **Scan Providers** to inspect installed extensions for likely diagnostic commands. Nothing is added automatically.

## Cleaning task diagnostics

Some Problems entries come from VS Code task problem matchers. To clean those safely:

1. Add the exact task names to `problemsCleaner.clearedTasks`.
2. Run **Clear Allowed Tasks**.

Only tasks in that allowlist can be stopped and restarted. An empty allowlist means no task is restarted.

```jsonc
{
  "problemsCleaner.clearedTasks": [
    "tsc: watch - tsconfig.json",
    "eslint: whole folder"
  ]
}
```

Enable `problemsCleaner.refreshTasks` only if you want **Refresh Problems** to detect and re-run matching tasks automatically. This is disabled by default because task restarts can be expensive.

## Commands

- **Problems Cleaner: Refresh Problems** — run the safe, source-aware refresh.
- **Problems Cleaner: Clear Allowed Tasks** — restart only allowlisted diagnostic tasks.
- **Problems Cleaner: Show Diagnostics Report** — inspect counts, sources, severities, and missing-file diagnostics.
- **Problems Cleaner: Copy All Problems** — copy every current diagnostic, including file, severity, source, range, code, and message.
- **Problems Cleaner: Restart Extension Host** — restart all extension-host extensions after confirmation.
- **Problems Cleaner: Refresh Provider for Problem** — refresh one configured provider.
- **Problems Cleaner: Restart Provider for Problem** — use the host-wide restart fallback for a selected provider.
- **Problems Cleaner: Settings** — configure commands and behavior.
- **Problems Cleaner: Scan Providers** — find installed extensions with likely diagnostic commands.
- **Problems Cleaner: Cancel Operation** — stop a running Problems Cleaner operation at the next safe point.

## Configuration

```jsonc
{
  "problemsCleaner.providerRefreshCommands": [
    "typescript.restartTsServer",
    "eslint.restart",
    "stylelint.restart"
  ],
  "problemsCleaner.refreshOnlyRelevantProviders": true,
  "problemsCleaner.refreshTasks": false,
  "problemsCleaner.clearedTasks": [],
  "problemsCleaner.showSetupOnFirstInstall": false,
  "problemsCleaner.openProblemsAfterRefresh": false,
  "problemsCleaner.showStatusBarButton": true,
  "problemsCleaner.hardRefreshMode": "restartExtensionHost"
}
```

The settings webview is the recommended way to edit these values. Provider commands are opt-in, and `refreshOnlyRelevantProviders` should normally remain `true` so unrelated extensions do not restart or make requests.

## What Problems Cleaner can and cannot do

Problems Cleaner cannot directly delete diagnostics owned by another extension because VS Code does not expose that public API. It can:

- request a configured provider refresh;
- re-run explicitly allowed task problem matchers;
- identify diagnostics pointing to missing files;
- show which sources and tasks are involved;
- restart the Extension Host after confirmation when a provider is stuck.

Restarting the Extension Host affects all extensions in that host. Reloading the entire window is more disruptive and should be reserved for the configured fallback case.

## Privacy and performance

Problems Cleaner has no workspace watcher and performs no automatic refresh loop. It reads VS Code diagnostics, installed extension metadata, and configured workspace tasks when you open or use its views. Provider commands and task execution occur only after an explicit user action or an enabled setting.

## Support

Please include the Problems Cleaner output-channel report, the VS Code version, and the diagnostic provider involved when reporting a problem. Do not include secrets or private workspace data.
