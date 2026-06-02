import * as vscode from 'vscode';

type SeverityKey = 'error' | 'warning' | 'information' | 'hint';

interface DiagnosticsSummary {
  total: number;
  bySeverity: Record<SeverityKey, number>;
  bySource: Map<string, number>;
  missingFiles: number;
  nonFileResources: number;
}

const EXTENSION_NAME = 'Problems Cleaner';
let statusBar: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });

  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('problemsCleaner.refreshProblems', () => refreshProblems(output, 'manual')),
    vscode.commands.registerCommand('problemsCleaner.hardRefreshProblems', () => hardRefreshProblems(output)),
    vscode.commands.registerCommand('problemsCleaner.showDiagnosticsReport', () => showDiagnosticsReport(output))
  );

  setupStatusBar(context);
  setupWorkspaceWatchers(context, output);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('problemsCleaner.showStatusBarButton')) {
        setupStatusBar(context);
      }
    })
  );

  output.info('Problems Cleaner activated.');
}

export function deactivate(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
}

async function refreshProblems(output: vscode.LogOutputChannel, reason: string): Promise<void> {
  const before = summarizeDiagnostics();
  output.info(`Soft refresh started. Reason=${reason}. Current diagnostics=${before.total}. Missing-file diagnostics=${before.missingFiles}.`);

  const config = vscode.workspace.getConfiguration('problemsCleaner');

  if (config.get<boolean>('saveAllBeforeRefresh', false)) {
    await vscode.workspace.saveAll(false);
  }

  await runConfiguredProviderCommands(output);
  await pokeOpenDocuments(output);

  // Give language servers and linters a short turn to republish diagnostics.
  await sleep(600);

  const after = summarizeDiagnostics();
  output.info(`Soft refresh finished. Before=${before.total}. After=${after.total}. Missing-file diagnostics=${after.missingFiles}.`);

  if (config.get<boolean>('openProblemsAfterRefresh', true)) {
    await safeExecute('workbench.actions.view.problems', output);
  }

  const message = after.missingFiles > 0
    ? `Refresh requested. ${after.total} diagnostics remain; ${after.missingFiles} still point at missing files. Use Hard Refresh if they are stale.`
    : `Refresh requested. ${after.total} diagnostics currently reported.`;

  vscode.window.setStatusBarMessage(`$(refresh) ${message}`, 5000);
}

async function hardRefreshProblems(output: vscode.LogOutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration('problemsCleaner');
  const mode = config.get<'restartExtensionHost' | 'reloadWindow'>('hardRefreshMode', 'restartExtensionHost');

  const action = await vscode.window.showWarningMessage(
    mode === 'reloadWindow'
      ? 'Hard refresh will reload the VS Code window. Unsaved files are normally restored, but save important work first.'
      : 'Hard refresh will restart the VS Code Extension Host. This usually clears stuck diagnostics from stale lint/build extensions.',
    { modal: true },
    'Run Hard Refresh'
  );

  if (action !== 'Run Hard Refresh') {
    return;
  }

  output.warn(`Hard refresh requested. Mode=${mode}.`);

  if (mode === 'reloadWindow') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
    return;
  }

  // This command exists in modern desktop VS Code. If unavailable, fall back to window reload.
  try {
    await vscode.commands.executeCommand('workbench.action.restartExtensionHost');
  } catch (error) {
    output.error(`Restart Extension Host failed; falling back to Reload Window. ${String(error)}`);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

async function showDiagnosticsReport(output: vscode.LogOutputChannel): Promise<void> {
  const summary = summarizeDiagnostics();
  output.clear();
  output.info('Diagnostics report generated.');
  output.appendLine('');
  output.appendLine('Problems Cleaner Diagnostics Report');
  output.appendLine('==================================');
  output.appendLine(`Total diagnostics: ${summary.total}`);
  output.appendLine(`Missing-file diagnostics: ${summary.missingFiles}`);
  output.appendLine(`Non-file diagnostics: ${summary.nonFileResources}`);
  output.appendLine('');
  output.appendLine('By severity:');
  output.appendLine(`  Errors: ${summary.bySeverity.error}`);
  output.appendLine(`  Warnings: ${summary.bySeverity.warning}`);
  output.appendLine(`  Information: ${summary.bySeverity.information}`);
  output.appendLine(`  Hints: ${summary.bySeverity.hint}`);
  output.appendLine('');
  output.appendLine('By source:');

  const sourceRows = [...summary.bySource.entries()].sort((a, b) => b[1] - a[1]);
  if (sourceRows.length === 0) {
    output.appendLine('  None');
  } else {
    for (const [source, count] of sourceRows) {
      output.appendLine(`  ${source}: ${count}`);
    }
  }

  output.appendLine('');
  output.appendLine('Note: VS Code diagnostics are owned by their publishing extension/task. This extension can request provider refreshes and restart the extension host, but it cannot directly mutate another owner\'s DiagnosticCollection.');
  output.show(true);
}

async function runConfiguredProviderCommands(output: vscode.LogOutputChannel): Promise<void> {
  const configured = vscode.workspace
    .getConfiguration('problemsCleaner')
    .get<string[]>('providerRefreshCommands', []);

  const available = new Set(await vscode.commands.getCommands(true));

  for (const command of configured) {
    if (!command || !available.has(command)) {
      output.debug(`Skipping unavailable provider refresh command: ${command}`);
      continue;
    }

    await safeExecute(command, output);
  }
}

async function pokeOpenDocuments(output: vscode.LogOutputChannel): Promise<void> {
  // Opening/showing visible documents often causes language servers to re-check current state without a full window reload.
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.scheme !== 'file') {
      continue;
    }

    try {
      await vscode.window.showTextDocument(editor.document, editor.viewColumn, false);
    } catch (error) {
      output.debug(`Unable to poke document ${editor.document.uri.toString()}: ${String(error)}`);
    }
  }
}

function summarizeDiagnostics(): DiagnosticsSummary {
  const diagnostics = vscode.languages.getDiagnostics();
  const bySource = new Map<string, number>();
  const bySeverity: Record<SeverityKey, number> = {
    error: 0,
    warning: 0,
    information: 0,
    hint: 0
  };

  let total = 0;
  let missingFiles = 0;
  let nonFileResources = 0;

  for (const [uri, items] of diagnostics) {
    if (uri.scheme !== 'file') {
      nonFileResources += items.length;
    }

    if (uri.scheme === 'file' && !fileExists(uri)) {
      missingFiles += items.length;
    }

    for (const diagnostic of items) {
      total += 1;
      const source = diagnostic.source || 'unknown';
      bySource.set(source, (bySource.get(source) || 0) + 1);

      switch (diagnostic.severity) {
        case vscode.DiagnosticSeverity.Error:
          bySeverity.error += 1;
          break;
        case vscode.DiagnosticSeverity.Warning:
          bySeverity.warning += 1;
          break;
        case vscode.DiagnosticSeverity.Information:
          bySeverity.information += 1;
          break;
        case vscode.DiagnosticSeverity.Hint:
          bySeverity.hint += 1;
          break;
      }
    }
  }

  return { total, bySeverity, bySource, missingFiles, nonFileResources };
}

function fileExists(uri: vscode.Uri): boolean {
  try {
    // Node-only extension, because this tool targets desktop/workspace diagnostics cleanup.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    return fs.existsSync(uri.fsPath);
  } catch {
    return true;
  }
}

function setupStatusBar(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace
    .getConfiguration('problemsCleaner')
    .get<boolean>('showStatusBarButton', true);

  statusBar?.dispose();
  statusBar = undefined;

  if (!enabled) {
    return;
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.text = '$(refresh) Problems';
  statusBar.tooltip = 'Refresh stale Problems diagnostics';
  statusBar.command = 'problemsCleaner.refreshProblems';
  statusBar.show();
  context.subscriptions.push(statusBar);
}

function setupWorkspaceWatchers(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): void {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*');

  const schedule = (reason: string): void => {
    const config = vscode.workspace.getConfiguration('problemsCleaner');
    if (!config.get<boolean>('autoRefreshOnFileDelete', true)) {
      return;
    }

    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }

    const debounce = config.get<number>('autoRefreshDebounceMs', 1500);
    refreshTimer = setTimeout(() => {
      void refreshProblems(output, reason);
    }, debounce);
  };

  watcher.onDidDelete(() => schedule('file-delete'), null, context.subscriptions);
  watcher.onDidCreate(() => schedule('file-create-or-rename'), null, context.subscriptions);
  context.subscriptions.push(watcher);
}

async function safeExecute(command: string, output: vscode.LogOutputChannel): Promise<void> {
  try {
    output.debug(`Executing command: ${command}`);
    await vscode.commands.executeCommand(command);
  } catch (error) {
    output.debug(`Command failed or unavailable: ${command}. ${String(error)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
