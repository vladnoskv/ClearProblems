import * as vscode from 'vscode';

type SeverityKey = 'error' | 'warning' | 'information' | 'hint';

interface DiagnosticsSummary {
  total: number;
  bySeverity: Record<SeverityKey, number>;
  bySource: Map<string, number>;
  missingFiles: number;
  missingFileResources: MissingFileResource[];
  nonFileResources: number;
}

interface MissingFileResource {
  uri: vscode.Uri;
  count: number;
  sources: string[];
}

interface CommandRunSummary {
  executed: string[];
  skipped: string[];
  failed: string[];
}

interface ManagedExtensionConfig {
  id: string;
  label?: string;
  enabled?: boolean;
  commands: string[];
  autoDiscovered?: boolean;
}

interface ExtensionCandidate {
  id: string;
  label: string;
  commands: string[];
  installed: boolean;
  managed: boolean;
  autoScore: number;
}

interface DiagnosticTask {
  task: vscode.Task;
  source: string;
  diagnosticCount: number;
  matchedBy: 'name' | 'source' | 'problemMatcher';
}

const EXTENSION_NAME = 'Problems Cleaner';
const SETUP_STATE_KEY = 'problemsCleaner.setupPromptShown';
const MANAGED_EXTENSIONS_STATE_KEY = 'problemsCleaner.managedExtensions';
const DIAGNOSTIC_KEYWORDS = [
  'biome',
  'checker',
  'diagnostic',
  'eslint',
  'language server',
  'lint',
  'linter',
  'problem',
  'pylance',
  'stylelint',
  'typescript',
  'validator'
];
const REFRESH_COMMAND_KEYWORDS = [
  'clear',
  'diagnostic',
  'index',
  'language server',
  'lint',
  'refresh',
  'reload',
  'restart',
  'server',
  'status',
  'sync'
];
const PROVIDER_ALIASES: Record<string, string[]> = {
  typescript: ['typescript', 'ts', 'tsc'],
  python: ['python', 'pylance', 'pyright'],
  eslint: ['eslint'],
  stylelint: ['stylelint'],
  biome: ['biome'],
  svelte: ['svelte']
};
let statusBar: vscode.StatusBarItem | undefined;
let statusUpdateTimer: NodeJS.Timeout | undefined;
let dashboard: ProblemsCleanerDashboard | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let activeOperation: { label: string; cancellation: vscode.CancellationTokenSource } | undefined;
let lastDiagnosticsSummary: DiagnosticsSummary | undefined;
let extensionCandidatesCache: { candidates: ExtensionCandidate[]; expiresAt: number } | undefined;

const SETTINGS_BOOLEAN_KEYS = new Set([
  'refreshTasks',
  'refreshOnlyRelevantProviders',
  'showStatusBarButton',
  'saveAllBeforeRefresh',
  'openProblemsAfterRefresh',
  'showSetupOnFirstInstall'
]);
const SETTINGS_ARRAY_KEYS = new Set(['providerRefreshCommands', 'clearedTasks']);

class OperationCancelledError extends Error {
  constructor(label: string) {
    super(`${label} was cancelled.`);
    this.name = 'OperationCancelledError';
  }
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  const output = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  dashboard = new ProblemsCleanerDashboard(context.extensionUri, output);
  panelDashboard = new ProblemsCleanerPanelDashboard(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('problemsCleaner.dashboard', dashboard),
    vscode.commands.registerCommand('problemsCleaner.refreshProblems', () => refreshProblems(output, 'manual', true)),
    vscode.commands.registerCommand('problemsCleaner.cancelOperation', () => cancelActiveOperation(output)),
    vscode.commands.registerCommand('problemsCleaner.hardRefreshProblems', () => hardRefreshProblems(output)),
    vscode.commands.registerCommand('problemsCleaner.showDiagnosticsReport', () => showDiagnosticsReport(output)),
    vscode.commands.registerCommand('problemsCleaner.copyAllProblems', () => copyAllProblems(output)),
    vscode.commands.registerCommand('problemsCleaner.setup', () => runSetup(context, output, true)),
    vscode.commands.registerCommand('problemsCleaner.manageExtensions', () => openManager(context.extensionUri, output)),
    vscode.commands.registerCommand('problemsCleaner.addExtensionFromContext', (item) => addExtensionFromContext(item, output)),
    vscode.commands.registerCommand('problemsCleaner.refreshProviderFromProblem', (item) => refreshProviderFromProblem(item, output)),
    vscode.commands.registerCommand('problemsCleaner.hardRefreshProviderFromProblem', (item) => hardRefreshProviderFromProblem(item, output)),
    vscode.commands.registerCommand('problemsCleaner.clearProblems', () => clearProblems(output)),
    vscode.commands.registerCommand('problemsCleaner.openSettings', () => openSettings(context.extensionUri, output))
  );

  setupStatusBar(context);
  setupDiagnosticsStatusUpdates(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('problemsCleaner.showStatusBarButton')) {
        setupStatusBar(context);
      }
      if (event.affectsConfiguration('problemsCleaner')) {
        scheduleStatusBarUpdate();
      }
    })
  );

  void maybeRunFirstInstallSetup(context, output);
  output.info('Problems Cleaner activated.');
}

export function deactivate(): void {
  if (statusUpdateTimer) {
    clearTimeout(statusUpdateTimer);
  }
}

async function refreshProblems(output: vscode.LogOutputChannel, reason: string, showNotification = false): Promise<void> {
  await withCancellableOperation(
    'Refresh Problems',
    output,
    {
      location: showNotification ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
      title: 'Problems Cleaner'
    },
    async (progress, token) => {
      await refreshProblemsCore(output, reason, progress, showNotification, token);
    }
  );
}

async function refreshProblemsCore(
  output: vscode.LogOutputChannel,
  reason: string,
  progress: vscode.Progress<{ message?: string }>,
  showNotification: boolean,
  token: vscode.CancellationToken
): Promise<void> {
  throwIfCancelled(token, 'Refresh Problems');
  progress.report({ message: 'Reading diagnostics...' });
  const before = await summarizeDiagnostics();
  throwIfCancelled(token, 'Refresh Problems');
  output.info(`Soft refresh started. Reason=${reason}. Current diagnostics=${before.total}. Missing-file diagnostics=${before.missingFiles}.`);

  const config = vscode.workspace.getConfiguration('problemsCleaner');

  if (config.get<boolean>('saveAllBeforeRefresh', false)) {
    progress.report({ message: 'Saving open files...' });
    await vscode.workspace.saveAll(false);
    throwIfCancelled(token, 'Refresh Problems');
  }

  progress.report({ message: 'Checking relevant diagnostic providers...' });
  const configuredCommands = getConfiguredRefreshCommands();
  const commandsToRun = config.get<boolean>('refreshOnlyRelevantProviders', true)
    ? selectRelevantProviderCommands(configuredCommands, before.bySource.keys())
    : configuredCommands;
  if (commandsToRun.length === 0) {
    output.info('No configured provider commands matched the current diagnostic sources. No provider was restarted.');
  }
  const commands = await runProviderCommands(commandsToRun, output, token);
  throwIfCancelled(token, 'Refresh Problems');

  let taskResult = { executed: [] as string[], skipped: [] as string[], failed: [] as string[] };
  if (config.get<boolean>('refreshTasks', false)) {
    progress.report({ message: 'Finding matching tasks...' });
    const diagnosticTasks = await fetchDiagnosticTasks();
    throwIfCancelled(token, 'Refresh Problems');

    if (diagnosticTasks.length > 0) {
      output.info(`Found ${diagnosticTasks.length} task(s) matching current diagnostics.`);
      progress.report({ message: `Re-executing ${diagnosticTasks.length} task(s)...` });
      taskResult = await executeDiagnosticTasks(diagnosticTasks, output, token);
      throwIfCancelled(token, 'Refresh Problems');

      progress.report({ message: 'Waiting for task diagnostics to republish...' });
      await sleep(800, token, 'Refresh Problems');
    }
  }

  // Give providers a short turn to republish only when work was requested.
  if (commandsToRun.length > 0 || taskResult.executed.length > 0) {
    progress.report({ message: 'Waiting for diagnostics to republish...' });
    await sleep(600, token, 'Refresh Problems');
  }

  const after = await summarizeDiagnostics();
  throwIfCancelled(token, 'Refresh Problems');
  updateStatusBar(after);
  dashboard?.update(after);
  panelDashboard?.update(after);
  output.info(`Soft refresh finished. Before=${before.total}. After=${after.total}. Missing-file diagnostics=${after.missingFiles}. Commands executed=${commands.executed.length}. Skipped=${commands.skipped.length}. Failed=${commands.failed.length}. Tasks executed=${taskResult.executed.length}. Task failed=${taskResult.failed.length}.`);

  if (config.get<boolean>('openProblemsAfterRefresh', false)) {
    await safeExecute('workbench.actions.view.problems', output);
    throwIfCancelled(token, 'Refresh Problems');
  }

  const message = configuredCommands.length === 0
    ? `No provider refresh commands are configured. ${after.total} diagnostics currently reported.`
    : after.missingFiles > 0
    ? `Refresh requested. ${after.total} diagnostics remain; ${after.missingFiles} still point at missing files. Use Hard Refresh if they are stale.`
    : `Refresh requested. ${after.total} diagnostics currently reported.`;

  vscode.window.setStatusBarMessage(`$(refresh) ${message}`, 5000);
  if (showNotification) {
    void vscode.window.showInformationMessage(message);
  }
}

async function hardRefreshProblems(output: vscode.LogOutputChannel, allowActiveOperation = false): Promise<void> {
  if (activeOperation && !allowActiveOperation) {
    void vscode.window.showWarningMessage(`Cannot restart the Extension Host while ${activeOperation.label} is running. Cancel the operation first.`);
    return;
  }

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

function getAllowedTaskNames(): string[] {
  const config = vscode.workspace.getConfiguration('problemsCleaner');
  const configured = config.get<unknown>('clearedTasks', []);
  return Array.isArray(configured)
    ? configured.filter((name): name is string => typeof name === 'string').map((name) => name.trim()).filter(Boolean)
    : [];
}

function isTaskAllowed(task: vscode.Task): boolean {
  const allowed = getAllowedTaskNames();
  if (allowed.length === 0) {
    return false;
  }
  return allowed.some((name) => name.toLowerCase() === task.name.toLowerCase());
}

async function clearProblems(output: vscode.LogOutputChannel): Promise<void> {
  const allowedNames = getAllowedTaskNames();
  if (allowedNames.length === 0) {
    void vscode.window.showWarningMessage(
      'No tasks are configured in problemsCleaner.clearedTasks. Add task names to enable Clear Problems.',
      'Open Settings'
    ).then((action) => {
      if (action === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'problemsCleaner.clearedTasks');
      }
    });
    return;
  }

  await withCancellableOperation(
    'Clear Problems',
    output,
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Problems Cleaner: Clear Problems'
    },
    async (progress, token) => {
      throwIfCancelled(token, 'Clear Problems');
      progress.report({ message: 'Reading diagnostics...' });
      const before = await summarizeDiagnostics();
      output.info(`Clear Problems started. Current diagnostics=${before.total}. Missing-file=${before.missingFiles}.`);

      throwIfCancelled(token, 'Clear Problems');
      progress.report({ message: 'Finding diagnostic tasks...' });
      const diagnosticTasks = await fetchDiagnosticTasks();
      throwIfCancelled(token, 'Clear Problems');

      if (diagnosticTasks.length === 0) {
        output.info('Clear Problems: no tasks matched current diagnostics.');
        vscode.window.setStatusBarMessage(`$(pass) No task-owned diagnostics to clear.`, 4000);
        return;
      }

      const allowedTasks = dedupeDiagnosticTasks(diagnosticTasks.filter((entry) => isTaskAllowed(entry.task)));
      const blockedTasks = diagnosticTasks.filter((entry) => !isTaskAllowed(entry.task));
      const blockedNames = [...new Set(blockedTasks.map((t) => t.task.name))];

      if (blockedNames.length > 0) {
        output.info(`Clear Problems: skipping ${blockedNames.length} task(s) not in clearedTasks list: ${blockedNames.join(', ')}.`);
      }

      throwIfCancelled(token, 'Clear Problems');

      let terminated = 0;
      let restartFailed = 0;
      let restarted = 0;

      const runningExecutions = vscode.tasks.taskExecutions;
      const runningTaskNames = new Set(
        runningExecutions.map((exec) => taskIdentity(exec.task))
      );

      // Only terminate tasks the user explicitly allowed. Matching a diagnostic
      // does not grant permission to stop an unrelated task.
      for (const entry of allowedTasks) {
        throwIfCancelled(token, 'Clear Problems');

        if (runningTaskNames.has(taskIdentity(entry.task))) {
          const running = runningExecutions.filter(
            (exec) => taskIdentity(exec.task) === taskIdentity(entry.task)
          );

          for (const exec of running) {
            try {
              output.info(`Clear Problems: terminating running task "${entry.task.name}".`);
              exec.terminate();
              terminated += 1;
            } catch (error) {
              output.debug(`Failed to terminate task "${entry.task.name}": ${String(error)}`);
            }
          }
        }
      }

      if (terminated > 0) {
        progress.report({ message: `Terminated ${terminated} task(s), waiting for cleanup...` });
        await sleep(1000, token, 'Clear Problems');
        throwIfCancelled(token, 'Clear Problems');
      }

      if (allowedTasks.length === 0) {
        output.info(`Clear Problems: no allowed tasks to restart. ${terminated} task(s) terminated.`);
        const after = await summarizeDiagnostics();
        updateStatusBar(after);
        dashboard?.update(after);
        panelDashboard?.update(after);
        vscode.window.setStatusBarMessage(
          `$(clear-all) ${terminated} task(s) terminated. ${blockedNames.length} task(s) not in clearedTasks list.`,
          6000
        );
        return;
      }

      progress.report({ message: `Restarting ${allowedTasks.length} allowed task(s)...` });
      for (const entry of allowedTasks) {
        throwIfCancelled(token, 'Clear Problems');

        try {
          output.info(`Clear Problems: restarting allowed task "${entry.task.name}" (${entry.diagnosticCount} diagnostics from "${entry.source}").`);
          await executeTaskAndWait(entry.task, output, token, 'Clear Problems');
          restarted += 1;
        } catch (error) {
          if (isOperationCancelledError(error)) {
            throw error;
          }
          output.debug(`Failed to restart task "${entry.task.name}": ${String(error)}`);
          restartFailed += 1;
        }
      }

      progress.report({ message: 'Waiting for diagnostics to republish...' });
      await sleep(1000, token, 'Clear Problems');
      throwIfCancelled(token, 'Clear Problems');

      const after = await summarizeDiagnostics();
      updateStatusBar(after);
      dashboard?.update(after);
      panelDashboard?.update(after);

      output.info(`Clear Problems finished. Before=${before.total}. After=${after.total}. Tasks terminated=${terminated}. Restarted=${restarted}. Failed=${restartFailed}. Skipped=${blockedNames.length}.`);

      let statusMsg = `$(clear-all) Clear Problems: ${restarted} task(s) restarted.`;
      if (terminated > 0) {
        statusMsg += ` ${terminated} terminated.`;
      }
      if (blockedNames.length > 0) {
        statusMsg += ` ${blockedNames.length} skipped.`;
      }
      vscode.window.setStatusBarMessage(statusMsg, 6000);

      void vscode.window.showInformationMessage(
        `Clear Problems: ${terminated} task(s) terminated, ${restarted} restarted. Diagnostics ${before.total} → ${after.total}.`
      );
    }
  );
}

async function showDiagnosticsReport(output: vscode.LogOutputChannel): Promise<void> {
  const summary = await summarizeDiagnostics();
  updateStatusBar(summary);
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
  output.appendLine('Missing file diagnostics:');
  if (summary.missingFileResources.length === 0) {
    output.appendLine('  None');
  } else {
    for (const resource of summary.missingFileResources.slice(0, 25)) {
      output.appendLine(`  ${resource.uri.fsPath}: ${resource.count} (${resource.sources.join(', ')})`);
    }

    const hidden = summary.missingFileResources.length - 25;
    if (hidden > 0) {
      output.appendLine(`  ...and ${hidden} more missing files.`);
    }
  }

  output.appendLine('');
  output.appendLine('Note: VS Code diagnostics are owned by their publishing extension/task. This extension can request provider refreshes and restart the extension host, but it cannot directly mutate another owner\'s DiagnosticCollection.');
  output.show(true);
}

async function copyAllProblems(output: vscode.LogOutputChannel): Promise<void> {
  const diagnostics = vscode.languages.getDiagnostics();
  const lines: string[] = ['Problems Cleaner diagnostics', `Copied: ${new Date().toISOString()}`, ''];
  let total = 0;

  for (const [uri, items] of diagnostics) {
    for (const diagnostic of items) {
      total += 1;
      const severity = diagnosticSeverityLabel(diagnostic.severity);
      const range = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}-${diagnostic.range.end.line + 1}:${diagnostic.range.end.character + 1}`;
      const source = diagnostic.source ? ` [${diagnostic.source}]` : '';
      const code = diagnostic.code === undefined ? '' : ` (${formatDiagnosticCode(diagnostic.code)})`;
      lines.push(`${uri.scheme === 'file' ? uri.fsPath : uri.toString()}\n  ${severity}${source} ${range}${code}: ${diagnostic.message}`);
    }
  }

  if (total === 0) {
    lines.push('No diagnostics reported.');
  }

  try {
    await vscode.env.clipboard.writeText(lines.join('\n'));
    output.info(`Copied ${total} diagnostic${total === 1 ? '' : 's'} to the clipboard.`);
    void vscode.window.showInformationMessage(`Copied ${total} problem${total === 1 ? '' : 's'} to the clipboard.`);
  } catch (error) {
    output.error(`Could not copy diagnostics to the clipboard. ${String(error)}`);
    void vscode.window.showErrorMessage('Problems Cleaner could not copy diagnostics to the clipboard.');
  }
}

function diagnosticSeverityLabel(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return 'Error';
    case vscode.DiagnosticSeverity.Warning:
      return 'Warning';
    case vscode.DiagnosticSeverity.Information:
      return 'Information';
    case vscode.DiagnosticSeverity.Hint:
      return 'Hint';
    default:
      return 'Diagnostic';
  }
}

function formatDiagnosticCode(code: vscode.Diagnostic['code']): string {
  if (typeof code !== 'object' || code === null) {
    return String(code);
  }

  try {
    return JSON.stringify(code);
  } catch {
    return '[unserializable diagnostic code]';
  }
}

async function runProviderCommands(configured: string[], output: vscode.LogOutputChannel, token?: vscode.CancellationToken): Promise<CommandRunSummary> {
  const available = new Set(await vscode.commands.getCommands(true));
  const summary: CommandRunSummary = {
    executed: [],
    skipped: [],
    failed: []
  };

  for (const command of configured) {
    throwIfCancelled(token, 'Provider Refresh');

    if (!command || !available.has(command)) {
      output.debug(`Skipping unavailable provider refresh command: ${command}`);
      summary.skipped.push(command);
      continue;
    }

    if (await safeExecute(command, output)) {
      summary.executed.push(command);
    } else {
      summary.failed.push(command);
    }

    throwIfCancelled(token, 'Provider Refresh');
  }

  return summary;
}

async function refreshManagedProvider(provider: ManagedExtensionConfig, output: vscode.LogOutputChannel, showNotification: boolean, targetUri?: vscode.Uri): Promise<void> {
  const label = provider.label ?? provider.id;
  await withCancellableOperation(
    `Refresh ${label}`,
    output,
    {
      location: showNotification ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
      title: `Problems Cleaner: ${label}`
    },
    async (progress, token) => {
      throwIfCancelled(token, `Refresh ${label}`);
      progress.report({ message: 'Reading diagnostics...' });
      const before = await summarizeDiagnostics();
      throwIfCancelled(token, `Refresh ${label}`);
      const beforeTargetCount = targetUri ? vscode.languages.getDiagnostics(targetUri).length : before.total;

      progress.report({ message: 'Running provider refresh commands...' });
      const commands = await runProviderCommands(provider.commands, output, token);
      throwIfCancelled(token, `Refresh ${label}`);

      progress.report({ message: 'Waiting for diagnostics to republish...' });
      await sleep(600, token, `Refresh ${label}`);

      const after = await summarizeDiagnostics();
      throwIfCancelled(token, `Refresh ${label}`);
      const afterTargetCount = targetUri ? vscode.languages.getDiagnostics(targetUri).length : after.total;
      updateStatusBar(after);
      dashboard?.update(after);
      panelDashboard?.update(after);

      const scope = targetUri ? `file diagnostics ${beforeTargetCount} -> ${afterTargetCount}` : `diagnostics ${before.total} -> ${after.total}`;
      const message = `${provider.label ?? provider.id}: executed ${commands.executed.length} command${commands.executed.length === 1 ? '' : 's'}; ${scope}.`;
      output.info(message);
      if (showNotification) {
        const action = await vscode.window.showInformationMessage(
          afterTargetCount >= beforeTargetCount
            ? `${message} If this provider is still stale, restart the Extension Host.`
            : message,
          'Restart Extension Host',
          'Open Dashboard'
        );
        throwIfCancelled(token, `Refresh ${label}`);
        if (action === 'Restart Extension Host') {
          await hardRefreshProblems(output, true);
        } else if (action === 'Open Dashboard') {
          openManager(extensionContext?.extensionUri, output);
        }
      }
    }
  );
}

function getConfiguredRefreshCommands(): string[] {
  const config = vscode.workspace.getConfiguration('problemsCleaner');
  const configured = config.get<unknown>('providerRefreshCommands', []);
  const legacyCommands = Array.isArray(configured)
    ? configured.filter((command): command is string => typeof command === 'string')
    : [];
  const managedCommands = getManagedExtensions()
    .filter((extension) => extension.enabled !== false)
    .flatMap((extension) => extension.commands);

  return uniqueStrings([...legacyCommands, ...managedCommands]);
}

function selectRelevantProviderCommands(commands: string[], sources: Iterable<string>): string[] {
  const diagnosticSources = [...sources].map(normalizeProviderToken).filter(Boolean);
  if (diagnosticSources.length === 0) {
    return [];
  }

  return commands.filter((command) => {
    const provider = normalizeProviderToken(command.split('.')[0] ?? command);
    if (!provider) {
      return false;
    }

    const providerTokens = PROVIDER_ALIASES[provider] ?? [provider];
    return diagnosticSources.some((source) => providerTokens.some((token) => source === token || source.includes(token) || token.includes(source)));
  });
}

function normalizeProviderToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/)[0] ?? '';
}

async function fetchDiagnosticTasks(): Promise<DiagnosticTask[]> {
  const diagnostics = vscode.languages.getDiagnostics();
  const diagnosticSources = new Map<string, number>();

  for (const [, items] of diagnostics) {
    for (const diag of items) {
      const source = diag.source;
      if (source) {
        diagnosticSources.set(source, (diagnosticSources.get(source) || 0) + 1);
      }
    }
  }

  if (diagnosticSources.size === 0) {
    return [];
  }

  const tasks = await vscode.tasks.fetchTasks();
  const runningNames = new Set(
    vscode.tasks.taskExecutions.map((exec) => exec.task.name.toLowerCase())
  );
  const matched = new Map<string, DiagnosticTask>();

  function wordBoundaryMatch(source: string, haystack: string): boolean {
    const lower = source.toLowerCase();
    const hay = haystack.toLowerCase();
    if (hay === lower) { return true; }
    const idx = hay.indexOf(lower);
    if (idx === -1) { return false; }
    const before = idx === 0 || /\W/.test(hay[idx - 1]);
    const after = idx + lower.length >= hay.length || /\W/.test(hay[idx + lower.length]);
    return before && after;
  }

  for (const task of tasks) {
    const taskName = task.name.toLowerCase();
    const taskSource = task.source.toLowerCase();
    const matchers = (task.problemMatchers ?? []).map((m) => m.replace(/^\$/, '').toLowerCase());
    const isRunning = runningNames.has(taskName);

    for (const [diagSource, count] of diagnosticSources) {
      const key = `${task.name}|${diagSource}`;
      if (matched.has(key)) {
        continue;
      }

      const lower = diagSource.toLowerCase();

      if (isRunning && (taskName.includes(lower) || lower.includes(taskName))) {
        matched.set(key, { task, source: diagSource, diagnosticCount: count, matchedBy: 'name' });
      } else if (!isRunning && wordBoundaryMatch(diagSource, task.name)) {
        matched.set(key, { task, source: diagSource, diagnosticCount: count, matchedBy: 'name' });
      } else if (matchers.some((m) => m === lower || wordBoundaryMatch(lower, m))) {
        matched.set(key, { task, source: diagSource, diagnosticCount: count, matchedBy: 'problemMatcher' });
      }
    }
  }

  return [...matched.values()].sort((a, b) => b.diagnosticCount - a.diagnosticCount);
}

async function executeDiagnosticTasks(
  tasks: DiagnosticTask[],
  output: vscode.LogOutputChannel,
  token?: vscode.CancellationToken
): Promise<{ executed: string[]; skipped: string[]; failed: string[] }> {
  const result = { executed: [] as string[], skipped: [] as string[], failed: [] as string[] };

  for (const entry of dedupeDiagnosticTasks(tasks)) {
    throwIfCancelled(token, 'Task Refresh');

    try {
      output.info(`Re-executing task "${entry.task.name}" (matched by ${entry.matchedBy}) to refresh ${entry.diagnosticCount} diagnostic(s) from "${entry.source}".`);
      await executeTaskAndWait(entry.task, output, token, 'Task Refresh');
      result.executed.push(entry.task.name);
    } catch (error) {
      if (isOperationCancelledError(error)) {
        throw error;
      }
      output.debug(`Failed to execute task "${entry.task.name}": ${String(error)}`);
      result.failed.push(entry.task.name);
    }
  }

  return result;
}

function dedupeDiagnosticTasks(tasks: DiagnosticTask[]): DiagnosticTask[] {
  const byTask = new Map<string, DiagnosticTask>();

  for (const entry of tasks) {
    const key = taskIdentity(entry.task);
    const existing = byTask.get(key);
    if (existing) {
      existing.diagnosticCount += entry.diagnosticCount;
      continue;
    }
    byTask.set(key, { ...entry });
  }

  return [...byTask.values()];
}

function taskIdentity(task: vscode.Task): string {
  return `${task.source.toLowerCase()}\u0000${task.name.toLowerCase()}`;
}

async function waitForTaskOutput(
  task: vscode.Task,
  output: vscode.LogOutputChannel,
  token: vscode.CancellationToken | undefined,
  label: string,
  startTask: () => Thenable<vscode.TaskExecution>
): Promise<void> {
  const config = vscode.workspace.getConfiguration('problemsCleaner');

  if (task.isBackground) {
    const waitMs = config.get<number>('backgroundTaskWaitMs', 8000);
    output.debug(`Task "${task.name}" is a background task; waiting ${waitMs}ms for initial compilation.`);
    await startTask();
    await sleep(waitMs, token, label);
    return;
  }

  const timeoutMs = config.get<number>('taskExecutionTimeoutMs', 120000);

  await new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    let subscription: vscode.Disposable;
    let cancelSub: vscode.Disposable | undefined;
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      subscription.dispose();
      cancelSub?.dispose();
      callback();
    };

    subscription = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution.task.name === task.name && e.execution.task.source === task.source) {
        finish(() => {
          if (e.exitCode !== undefined && e.exitCode !== 0) {
            output.debug(`Task "${task.name}" exited with code ${e.exitCode}.`);
          }
          resolve();
        });
      }
    });

    cancelSub = token?.onCancellationRequested(() => {
      finish(() => reject(new OperationCancelledError(label)));
    });

    timeout = setTimeout(() => {
      finish(() => reject(new Error(`Task "${task.name}" timed out after ${timeoutMs / 1000}s.`)));
    }, timeoutMs);

    void startTask().then(undefined, (error: unknown) => {
      finish(() => reject(error));
    });
  });
}

async function executeTaskAndWait(
  task: vscode.Task,
  output: vscode.LogOutputChannel,
  token: vscode.CancellationToken | undefined,
  label: string
): Promise<void> {
  await waitForTaskOutput(task, output, token, label, () => vscode.tasks.executeTask(task));
}

async function summarizeDiagnostics(): Promise<DiagnosticsSummary> {
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
  const missingFileResources: MissingFileResource[] = [];

  for (const [uri, items] of diagnostics) {
    if (uri.scheme !== 'file') {
      nonFileResources += items.length;
    }

    const sources = [...new Set(items.map((diagnostic) => diagnostic.source || 'unknown'))].sort();
    if (uri.scheme === 'file' && !(await fileExists(uri))) {
      missingFiles += items.length;
      missingFileResources.push({
        uri,
        count: items.length,
        sources
      });
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

  missingFileResources.sort((a, b) => b.count - a.count || a.uri.fsPath.localeCompare(b.uri.fsPath));

  return { total, bySeverity, bySource, missingFiles, missingFileResources, nonFileResources };
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function maybeRunFirstInstallSetup(context: vscode.ExtensionContext, output: vscode.LogOutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration('problemsCleaner');
  if (!config.get<boolean>('showSetupOnFirstInstall', false) || context.globalState.get<boolean>(SETUP_STATE_KEY)) {
    return;
  }

  await context.globalState.update(SETUP_STATE_KEY, true);
  const action = await vscode.window.showInformationMessage(
    'Problems Cleaner can scan installed extensions and add likely diagnostic providers to refresh.',
    'Run Setup',
    'Later'
  );

  if (action === 'Run Setup') {
    await runSetup(context, output, true);
  }
}

async function runSetup(context: vscode.ExtensionContext, output: vscode.LogOutputChannel, interactive: boolean): Promise<void> {
  const candidates = await discoverExtensionCandidates();
  const suggested = candidates.filter((candidate) => candidate.autoScore > 0 && candidate.commands.length > 0);

  if (suggested.length === 0) {
    await context.globalState.update(SETUP_STATE_KEY, true);
    void vscode.window.showInformationMessage('Problems Cleaner did not find installed extensions with obvious refresh or restart commands.');
    openManager(context.extensionUri, output);
    return;
  }

  const picked = interactive
    ? await vscode.window.showQuickPick(
      suggested.map((candidate) => ({
        label: candidate.label,
        description: candidate.id,
        detail: `${candidate.commands.length} refresh command${candidate.commands.length === 1 ? '' : 's'}: ${candidate.commands.join(', ')}`,
        candidate,
        picked: candidate.autoScore >= 2
      })),
      {
        title: 'Problems Cleaner Setup',
        placeHolder: 'Select extensions to include in Problems Refresh',
        canPickMany: true
      }
    )
    : suggested.map((candidate) => ({ candidate }));

  if (!picked || picked.length === 0) {
    openManager(context.extensionUri, output);
    return;
  }

  await upsertManagedExtensions(picked.map((item) => ({
    id: item.candidate.id,
    label: item.candidate.label,
    enabled: true,
    commands: item.candidate.commands,
    autoDiscovered: true
  })));

  await context.globalState.update(SETUP_STATE_KEY, true);
  output.info(`Setup added ${picked.length} extension provider entries.`);
  dashboard?.refreshModel();
  panelDashboard?.update();
  void vscode.window.showInformationMessage(`Problems Cleaner added ${picked.length} extension provider${picked.length === 1 ? '' : 's'} to refresh.`);
  openManager(context.extensionUri, output);
}

async function addExtensionFromContext(item: unknown, output: vscode.LogOutputChannel): Promise<void> {
  const extensionId = resolveExtensionIdFromContext(item);
  if (!extensionId) {
    await addExtensionByPicker(output);
    return;
  }

  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === extensionId.toLowerCase());
  if (!extension) {
    void vscode.window.showWarningMessage(`Problems Cleaner could not resolve extension ${extensionId}.`);
    return;
  }

  await addExtensionWithCommandPicker(extension, output);
}

async function refreshProviderFromProblem(item: unknown, output: vscode.LogOutputChannel): Promise<void> {
  const targetUri = resolveUriFromContext(item);
  const provider = await pickProviderForProblem(item, targetUri);
  if (!provider) {
    return;
  }

  await refreshManagedProvider(provider, output, true, targetUri);
}

async function hardRefreshProviderFromProblem(item: unknown, output: vscode.LogOutputChannel): Promise<void> {
  const targetUri = resolveUriFromContext(item);
  const provider = await pickProviderForProblem(item, targetUri);
  if (!provider) {
    return;
  }

  await confirmProviderHostRestart(provider, output);
}

async function confirmProviderHostRestart(provider: ManagedExtensionConfig, output: vscode.LogOutputChannel): Promise<void> {
  const action = await vscode.window.showWarningMessage(
    `VS Code does not expose a public API to restart only ${provider.label ?? provider.id}. Restarting the Extension Host is the available hard refresh and affects all extensions.`,
    { modal: true },
    'Restart Extension Host',
    'Open Dashboard'
  );

  if (action === 'Restart Extension Host') {
    await hardRefreshProblems(output);
  } else if (action === 'Open Dashboard') {
    openManager(extensionContext?.extensionUri, output);
  }
}

async function refreshManagedProviderById(id: string, output: vscode.LogOutputChannel): Promise<void> {
  const provider = getManagedExtensions().find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!provider) {
    void vscode.window.showWarningMessage(`Problems Cleaner could not find provider ${id}.`);
    return;
  }

  await refreshManagedProvider(provider, output, true);
}

async function hardRefreshManagedProviderById(id: string, output: vscode.LogOutputChannel): Promise<void> {
  const provider = getManagedExtensions().find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!provider) {
    void vscode.window.showWarningMessage(`Problems Cleaner could not find provider ${id}.`);
    return;
  }

  await confirmProviderHostRestart(provider, output);
}

async function pickProviderForProblem(item: unknown, targetUri?: vscode.Uri): Promise<ManagedExtensionConfig | undefined> {
  const providers = getManagedExtensions().filter((provider) => provider.enabled !== false);
  if (providers.length === 0) {
    const action = await vscode.window.showInformationMessage(
      'No Problems Cleaner providers are configured yet.',
      'Open Dashboard'
    );
    if (action === 'Open Dashboard') {
      openManager(extensionContext?.extensionUri);
    }
    return undefined;
  }

  const source = resolveDiagnosticSourceFromContext(item) ?? resolveDiagnosticSourceFromUri(targetUri);
  const matched = source ? matchProviderBySource(source, providers) : undefined;
  if (matched) {
    return matched;
  }

  const picked = await vscode.window.showQuickPick(
    providers.map((provider) => ({
      label: provider.label ?? provider.id,
      description: provider.id,
      detail: provider.commands.length > 0 ? provider.commands.join(', ') : 'No provider commands configured',
      provider
    })),
    {
      title: source ? `No provider matched source "${source}"` : 'Choose provider to refresh',
      placeHolder: 'Select the extension/provider that owns this problem'
    }
  );

  return picked?.provider;
}

function resolveDiagnosticSourceFromContext(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const direct = findStringProperty(item, ['source', 'owner', 'code', 'message']);
  if (direct && direct.length <= 80) {
    return direct;
  }

  const record = item as Record<string, unknown>;
  for (const value of Object.values(record)) {
    if (value && typeof value === 'object') {
      const nested = findStringProperty(value, ['source', 'owner']);
      if (nested) {
        return nested;
      }
    }
  }

  return undefined;
}

function resolveDiagnosticSourceFromUri(uri?: vscode.Uri): string | undefined {
  if (!uri) {
    return undefined;
  }

  const diagnostics = vscode.languages.getDiagnostics(uri);
  const activeLine = vscode.window.activeTextEditor?.selection.active.line;
  const lineDiagnostics = typeof activeLine === 'number'
    ? diagnostics.filter((diagnostic) => diagnostic.range.start.line <= activeLine && diagnostic.range.end.line >= activeLine)
    : [];
  const candidate = lineDiagnostics[0] ?? diagnostics[0];
  return candidate?.source;
}

function resolveUriFromContext(item: unknown): vscode.Uri | undefined {
  if (item instanceof vscode.Uri) {
    return item;
  }

  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    const uri = record.resourceUri ?? record.uri;
    if (uri instanceof vscode.Uri) {
      return uri;
    }
  }

  return vscode.window.activeTextEditor?.document.uri;
}

function matchProviderBySource(source: string, providers: ManagedExtensionConfig[]): ManagedExtensionConfig | undefined {
  const normalized = normalizeName(source);
  return providers.find((provider) => {
    const haystack = [
      provider.id,
      provider.label ?? '',
      provider.commands.join(' ')
    ].map(normalizeName).join(' ');
    return haystack.includes(normalized) || normalized.includes(normalizeName(provider.label ?? provider.id));
  });
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function findStringProperty(item: unknown, keys: string[]): string | undefined {
  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

async function addExtensionByPicker(output: vscode.LogOutputChannel): Promise<void> {
  const candidates = await discoverExtensionCandidates();
  const picked = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.label,
      description: candidate.id,
      detail: candidate.commands.length > 0
        ? `${candidate.commands.length} possible refresh command${candidate.commands.length === 1 ? '' : 's'}`
        : 'No obvious refresh commands found',
      candidate
    })),
    {
      title: 'Add Extension to Problems Refresh',
      placeHolder: 'Choose an installed extension'
    }
  );

  if (!picked) {
    return;
  }

  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === picked.candidate.id.toLowerCase());
  if (extension) {
    await addExtensionWithCommandPicker(extension, output);
  }
}

async function configureExtensionById(id: string, output: vscode.LogOutputChannel): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!extension) {
    void vscode.window.showWarningMessage(`Problems Cleaner could not find installed extension ${id}.`);
    return;
  }

  await addExtensionWithCommandPicker(extension, output);
}

async function addExtensionWithCommandPicker(extension: vscode.Extension<unknown>, output: vscode.LogOutputChannel): Promise<void> {
  const commands = await getRefreshCommandCandidatesForExtension(extension);
  if (commands.length === 0) {
    const action = await vscode.window.showWarningMessage(
      `${getExtensionLabel(extension)} does not expose obvious refresh/restart commands. Add it with no commands so it is tracked in Problems Cleaner?`,
      'Track Extension',
      'Cancel'
    );

    if (action !== 'Track Extension') {
      return;
    }
  }

  const picked = commands.length > 0
    ? await vscode.window.showQuickPick(
      commands.map((command) => ({
        label: command,
        picked: true
      })),
      {
        title: `Refresh commands for ${getExtensionLabel(extension)}`,
        placeHolder: 'Select commands to run during Problems Refresh',
        canPickMany: true
      }
    )
    : [];

  if (!picked) {
    return;
  }

  await upsertManagedExtensions([{
    id: extension.id,
    label: getExtensionLabel(extension),
    enabled: true,
    commands: picked.map((item) => item.label),
    autoDiscovered: false
  }]);

  output.info(`Added managed extension ${extension.id} with ${picked.length} commands.`);
  dashboard?.refreshModel();
  panelDashboard?.update();
  void vscode.window.showInformationMessage(`Added ${getExtensionLabel(extension)} to Problems Refresh.`);
  if (extensionContext) {
    openManager(extensionContext.extensionUri, output);
  }
}

function resolveExtensionIdFromContext(item: unknown): string | undefined {
  if (typeof item === 'string') {
    return item;
  }

  if (!item || typeof item !== 'object') {
    return undefined;
  }

  const record = item as Record<string, unknown>;
  const direct = readString(record, 'id')
    ?? readString(record, 'identifier')
    ?? readString(record, 'extensionId');
  if (direct) {
    return direct;
  }

  const nestedKeys = ['extension', 'extensionIdentifier', 'identifier', 'local', 'gallery'];
  for (const key of nestedKeys) {
    const value = record[key];
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      const id = readString(nested, 'id') ?? readString(nested, 'uuid');
      if (id && id.includes('.')) {
        return id;
      }
    }
  }

  const publisher = readString(record, 'publisher') ?? readString(record, 'publisherDisplayName');
  const name = readString(record, 'name');
  return publisher && name ? `${publisher}.${name}` : undefined;
}

async function discoverExtensionCandidates(): Promise<ExtensionCandidate[]> {
  if (extensionCandidatesCache && extensionCandidatesCache.expiresAt > Date.now()) {
    return extensionCandidatesCache.candidates;
  }

  const managedIds = new Set(getManagedExtensions().map((extension) => extension.id.toLowerCase()));
  const allCommands = await vscode.commands.getCommands(true);
  const candidates = await Promise.all(
    vscode.extensions.all
      .filter((extension) => extension.id !== 'predictduel.vscode-problems-cleaner')
      .map(async (extension) => {
        const commands = await getRefreshCommandCandidatesForExtension(extension, allCommands);
        return {
          id: extension.id,
          label: getExtensionLabel(extension),
          commands,
          installed: true,
          managed: managedIds.has(extension.id.toLowerCase()),
          autoScore: scoreExtension(extension, commands)
        };
      })
  );

  const sorted = candidates.sort((a, b) => {
    if (a.managed !== b.managed) {
      return a.managed ? 1 : -1;
    }
    return b.autoScore - a.autoScore || a.label.localeCompare(b.label);
  });
  extensionCandidatesCache = { candidates: sorted, expiresAt: Date.now() + 10000 };
  return sorted;
}

async function getRefreshCommandCandidatesForExtension(extension: vscode.Extension<unknown>, knownCommands?: string[]): Promise<string[]> {
  const allCommands = knownCommands ?? await vscode.commands.getCommands(true);
  const packageCommands = readContributedCommands(extension);
  const extensionName = extension.id.split('.').pop()?.toLowerCase() ?? extension.id.toLowerCase();
  const prefixMatches = allCommands.filter((command) => command.toLowerCase().startsWith(`${extensionName}.`));
  const publisherMatches = allCommands.filter((command) => command.toLowerCase().startsWith(`${extension.id.toLowerCase()}.`));

  return uniqueStrings([...packageCommands, ...prefixMatches, ...publisherMatches])
    .filter((command) => isRefreshLike(`${command} ${getCommandTitle(extension, command)}`))
    .sort();
}

function readContributedCommands(extension: vscode.Extension<unknown>): string[] {
  const contributes = extension.packageJSON?.contributes as Record<string, unknown> | undefined;
  const commands = contributes?.commands;
  if (!Array.isArray(commands)) {
    return [];
  }

  return commands
    .map((command) => typeof command === 'object' && command ? readString(command as Record<string, unknown>, 'command') : undefined)
    .filter((command): command is string => Boolean(command));
}

function getCommandTitle(extension: vscode.Extension<unknown>, commandId: string): string {
  const contributes = extension.packageJSON?.contributes as Record<string, unknown> | undefined;
  const commands = contributes?.commands;
  if (!Array.isArray(commands)) {
    return '';
  }

  const command = commands.find((item) => typeof item === 'object' && item && readString(item as Record<string, unknown>, 'command') === commandId);
  return command && typeof command === 'object' ? readString(command as Record<string, unknown>, 'title') ?? '' : '';
}

function scoreExtension(extension: vscode.Extension<unknown>, commands: string[]): number {
  const text = [
    extension.id,
    getExtensionLabel(extension),
    readString(extension.packageJSON, 'description') ?? '',
    Array.isArray(extension.packageJSON?.keywords) ? extension.packageJSON.keywords.join(' ') : '',
    commands.join(' ')
  ].join(' ').toLowerCase();

  let score = commands.length > 0 ? 1 : 0;
  for (const keyword of DIAGNOSTIC_KEYWORDS) {
    if (text.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

function isRefreshLike(text: string): boolean {
  const lower = text.toLowerCase();
  return REFRESH_COMMAND_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function getExtensionLabel(extension: vscode.Extension<unknown>): string {
  return readString(extension.packageJSON, 'displayName')
    ?? readString(extension.packageJSON, 'name')
    ?? extension.id;
}

function getManagedExtensions(): ManagedExtensionConfig[] {
  const storedRaw = extensionContext?.globalState.get<ManagedExtensionConfig[] | undefined>(MANAGED_EXTENSIONS_STATE_KEY);
  const configured = vscode.workspace
    .getConfiguration('problemsCleaner')
    .get<ManagedExtensionConfig[]>('managedExtensions', []);
  const source = storedRaw ?? configured;
  const byId = new Map<string, ManagedExtensionConfig>();

  if (!Array.isArray(source)) {
    return [];
  }

  for (const extension of source) {
    if (!extension || typeof extension !== 'object') {
      continue;
    }

    const candidate = extension as Partial<ManagedExtensionConfig>;
    if (typeof candidate.id !== 'string' || !Array.isArray(candidate.commands)) {
      continue;
    }

    const commands = candidate.commands.filter((command): command is string => typeof command === 'string');
    const key = candidate.id.toLowerCase();
    const current = byId.get(key);
    byId.set(key, {
      ...current,
      ...candidate,
      id: candidate.id,
      commands: uniqueStrings([...(current?.commands ?? []), ...commands])
    });
  }

  return [...byId.values()];
}

async function upsertManagedExtensions(entries: ManagedExtensionConfig[]): Promise<void> {
  const existing = getManagedExtensions();
  const byId = new Map(existing.map((extension) => [extension.id.toLowerCase(), extension]));

  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    const current = byId.get(key);
    byId.set(key, {
      ...current,
      ...entry,
      enabled: entry.enabled ?? current?.enabled ?? true,
      commands: uniqueStrings([...(current?.commands ?? []), ...entry.commands])
    });
  }

  await updateManagedExtensions([...byId.values()].sort((a, b) => (a.label ?? a.id).localeCompare(b.label ?? b.id)));
  extensionCandidatesCache = undefined;
}

async function updateManagedExtensions(entries: ManagedExtensionConfig[]): Promise<void> {
  await extensionContext?.globalState.update(MANAGED_EXTENSIONS_STATE_KEY, entries);
}

async function removeManagedExtension(id: string): Promise<void> {
  await updateManagedExtensions(getManagedExtensions().filter((extension) => extension.id.toLowerCase() !== id.toLowerCase()));
  extensionCandidatesCache = undefined;
  dashboard?.refreshModel();
  panelDashboard?.update();
}

async function toggleManagedExtension(id: string): Promise<void> {
  const entries = getManagedExtensions().map((extension) => extension.id.toLowerCase() === id.toLowerCase()
    ? { ...extension, enabled: extension.enabled === false }
    : extension);
  await updateManagedExtensions(entries);
  extensionCandidatesCache = undefined;
  dashboard?.refreshModel();
  panelDashboard?.update();
}

async function removeManagedCommand(id: string, command: string): Promise<void> {
  const entries = getManagedExtensions().map((extension) => extension.id.toLowerCase() === id.toLowerCase()
    ? { ...extension, commands: extension.commands.filter((candidate) => candidate !== command) }
    : extension);
  await updateManagedExtensions(entries);
  extensionCandidatesCache = undefined;
  dashboard?.refreshModel();
  panelDashboard?.update();
}

async function addCommandToManagedExtension(id: string): Promise<void> {
  const extension = vscode.extensions.all.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
  if (!extension) {
    return;
  }

  const existing = getManagedExtensions().find((entry) => entry.id.toLowerCase() === id.toLowerCase());
  const commands = (await getRefreshCommandCandidatesForExtension(extension))
    .filter((command) => !existing?.commands.includes(command));

  const picked = await vscode.window.showQuickPick(
    commands.map((command) => ({ label: command })),
    {
      title: `Add refresh command for ${getExtensionLabel(extension)}`,
      placeHolder: commands.length > 0 ? 'Choose a command' : 'No additional refresh-like commands found'
    }
  );

  if (!picked) {
    return;
  }

  await upsertManagedExtensions([{
    id,
    label: getExtensionLabel(extension),
    enabled: existing?.enabled ?? true,
    commands: [picked.label],
    autoDiscovered: existing?.autoDiscovered ?? false
  }]);
  dashboard?.refreshModel();
  panelDashboard?.update();
}

function openManager(_extensionUri?: vscode.Uri, _output?: vscode.LogOutputChannel): void {
  const context = extensionContext;
  if (!context) {
    return;
  }

  if (!panelDashboard) {
    panelDashboard = new ProblemsCleanerPanelDashboard(context.extensionUri, _output ?? vscode.window.createOutputChannel(EXTENSION_NAME, { log: true }));
  }
  panelDashboard.show();
  void vscode.commands.executeCommand('workbench.view.extension.problemsCleaner').then(
    undefined,
    () => undefined
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readString(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== 'object') {
    return undefined;
  }

  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

class ProblemsCleanerDashboard implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private updateSequence = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    view.webview.html = renderDashboardHtml(view.webview, this.extensionUri);

    registerDashboardMessageHandler(view.webview, this.output);

    void this.update();
  }

  async update(summary?: DiagnosticsSummary): Promise<void> {
    const sequence = ++this.updateSequence;
    try {
      if (!this.view) {
        return;
      }

      const current = summary ?? await summarizeDiagnostics();
      const model = await toDashboardModel(current);
      if (sequence !== this.updateSequence || !this.view) {
        return;
      }
      await this.view.webview.postMessage({ type: 'model', model });
    } catch (error) {
      this.output.debug(`Dashboard update failed: ${String(error)}`);
    }
  }

  refreshModel(): void {
    void this.update();
  }

}

function renderDashboardHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'resources', 'icon.png'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 14px;
    }
    .header {
      align-items: center;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 10px;
      margin: -2px 0 14px;
      padding-bottom: 12px;
    }
    .header img {
      flex: 0 0 auto;
      height: 30px;
      width: 30px;
    }
    .title {
      font-size: 15px;
      font-weight: 600;
      line-height: 1.25;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      margin-top: 2px;
    }
    .actions {
      display: grid;
      gap: 8px;
      margin-bottom: 16px;
    }
    .action-divider {
      background: var(--vscode-panel-border);
      border: none;
      height: 1px;
      margin: 4px 0;
    }
    button {
      align-items: center;
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      display: flex;
      gap: 7px;
      justify-content: center;
      line-height: 1.2;
      min-height: 30px;
      padding: 5px 10px;
      text-align: center;
      width: 100%;
    }
    button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 16px;
    }
    .stat {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px;
    }
    .value {
      display: block;
      font-size: 22px;
      font-weight: 600;
      line-height: 1.1;
    }
    .label {
      color: var(--vscode-descriptionForeground);
      display: block;
      margin-top: 3px;
    }
    h2 {
      font-size: 12px;
      font-weight: 600;
      margin: 16px 0 8px;
      text-transform: uppercase;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    li {
      border-top: 1px solid var(--vscode-panel-border);
      padding: 7px 0;
    }
    .provider {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 8px;
      padding: 10px;
    }
    .row {
      display: flex;
      gap: 8px;
      justify-content: space-between;
    }
    .provider-title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .command {
      align-items: center;
      display: flex;
      gap: 6px;
      justify-content: space-between;
      margin-top: 6px;
    }
    .mini {
      min-height: 22px;
      padding: 2px 7px;
      width: auto;
    }
    .button-row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(70px, 1fr));
      gap: 6px;
      margin-top: 8px;
    }
    .button-row button {
      width: 100%;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .path {
      overflow-wrap: anywhere;
    }
    .notice { background: var(--vscode-textBlockQuote-background); border-left: 3px solid var(--vscode-textLink-foreground); margin: 12px 0; padding: 9px 10px; }
    .notice strong { display: block; margin-bottom: 3px; }
    .action-status { min-height: 18px; margin: 8px 0; color: var(--vscode-descriptionForeground); }
    button:focus-visible, summary:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    button[aria-busy="true"] { cursor: wait; opacity: .7; }
    details { margin: 18px 0; }
    summary { cursor: pointer; font-size: 14px; font-weight: 600; padding: 5px 0; }
    .section-help { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 2px 0 8px; }
  </style>
</head>
<body>
  <div class="header">
    <img src="${iconUri}" alt="">
    <div>
      <div class="title">Problems Cleaner</div>
      <div class="subtitle">Safe, targeted diagnostics cleanup</div>
    </div>
  </div>

  <div class="notice" role="status"><strong>Normal refresh is safe</strong><span id="refreshPlan">It does not restart the Extension Host or open editors. Only configured providers matching current diagnostics are considered.</span></div>

  <div class="actions">
    <button id="refresh" type="button" title="Refresh only configured providers that match current diagnostics">Refresh Problems</button>
    <button id="report" type="button" class="secondary">Show Diagnostics Report</button>
    <button id="copyProblems" type="button" class="secondary">Copy All Problems</button>
    <button id="clearProblems" type="button" class="secondary" title="Stop and restart only tasks explicitly allowed in settings">Clear Allowed Tasks</button>
    <button id="hardRefresh" type="button" class="secondary" title="Restart the entire Extension Host; use only when diagnostics remain stuck">Restart Extension Host</button>
    <hr class="action-divider">
    <button id="setup" type="button" class="secondary">Scan Providers</button>
    <button id="addExtension" type="button" class="secondary">Add Extension</button>
    <button id="settings" type="button" class="secondary">Settings</button>
  </div>
  <div id="actionStatus" class="action-status" role="status" aria-live="polite"></div>

  <div class="stats">
    <div class="stat"><span id="total" class="value">0</span><span class="label">Diagnostics</span></div>
    <div class="stat"><span id="missing" class="value">0</span><span class="label">Missing files</span></div>
    <div class="stat"><span id="errors" class="value">0</span><span class="label">Errors</span></div>
    <div class="stat"><span id="warnings" class="value">0</span><span class="label">Warnings</span></div>
  </div>

  <details open><summary>Top Sources</summary><p class="section-help">Current diagnostic owners detected from VS Code.</p><ul id="sources"><li class="muted">No diagnostics reported.</li></ul></details>

  <details open><summary>Managed Providers</summary><p class="section-help">Refresh runs only configured commands. Restart is always an explicit host-wide action.</p><div id="managedExtensions"><div class="muted">No managed extensions configured.</div></div></details>

  <details><summary>Provider Discovery</summary><p class="section-help">Suggestions are based on installed extensions and contributed commands. Nothing is added automatically.</p><div id="suggestedExtensions"><div class="muted">No suggestions found.</div></div></details>

  <details open><summary>Missing File Diagnostics</summary><ul id="missingFiles"><li class="muted">No missing file diagnostics.</li></ul></details>

  <details><summary>Diagnostic Tasks</summary><div id="diagnosticTasks"><div id="tasksDisabledNote" class="muted">Task scanning is disabled. Enable it in Settings to inspect task ownership.</div><div id="tasksNoMatch" class="muted" style="display:none">No task-owned diagnostics detected.</div><ul id="tasksList" style="display:none"></ul></div></details>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const actionLabels = { refresh: 'Refreshing relevant providers…', report: 'Generating diagnostics report…', copyAllProblems: 'Copying all problems…', setup: 'Scanning installed providers…', addExtension: 'Opening provider picker…', hardRefresh: 'Opening restart confirmation…', clearProblems: 'Cleaning allowed tasks…', openSettings: 'Opening settings…' };
    for (const [id, command] of Object.entries({ refresh: 'refresh', report: 'report', copyProblems: 'copyAllProblems', setup: 'setup', addExtension: 'addExtension', hardRefresh: 'hardRefresh', clearProblems: 'clearProblems', settings: 'openSettings' })) {
      document.getElementById(id).addEventListener('click', () => {
        const button = document.getElementById(id);
        button.setAttribute('aria-busy', 'true');
        document.getElementById('actionStatus').textContent = actionLabels[command] || 'Working…';
        vscode.postMessage({ command });
        setTimeout(() => button.removeAttribute('aria-busy'), 1200);
      });
    }

    window.addEventListener('message', (event) => {
      if (event.data.type !== 'model') {
        return;
      }
      const model = event.data.model;
      const summary = model.summary;
      document.getElementById('total').textContent = summary.total;
      document.getElementById('missing').textContent = summary.missingFiles;
      document.getElementById('errors').textContent = summary.bySeverity.error;
      document.getElementById('warnings').textContent = summary.bySeverity.warning;

      renderSources(summary.sources);
      renderManagedExtensions(model.managedExtensions);
      renderSuggestedExtensions(model.suggestedExtensions);
      renderMissingFiles(summary.missingFileResources);
      renderDiagnosticTasks(model.refreshTasksEnabled, model.diagnosticTasks);
      const plan = model.refreshPlan;
      document.getElementById('refreshPlan').textContent = plan.onlyRelevantProviders
        ? plan.relevantProviderCount + ' of ' + plan.configuredProviderCount + ' configured provider command(s) match ' + plan.diagnosticSourceCount + ' current diagnostic source(s). No unrelated provider is restarted.'
        : 'All configured provider commands are enabled. Disable this mode in Settings to prevent unrelated restarts.';
      document.getElementById('actionStatus').textContent = '';
    });

    function renderSources(sources) {
      const root = document.getElementById('sources');
      root.replaceChildren();
      if (sources.length === 0) {
        root.appendChild(emptyRow('No diagnostics reported.'));
        return;
      }
      for (const item of sources) {
        const row = document.createElement('li');
        const content = document.createElement('div');
        const label = document.createElement('span');
        const count = document.createElement('strong');
        content.className = 'row';
        label.textContent = item.source;
        count.textContent = item.count;
        content.append(label, count);
        row.appendChild(content);
        root.appendChild(row);
      }
    }

    function renderManagedExtensions(extensions) {
      const root = document.getElementById('managedExtensions');
      root.replaceChildren();
      if (extensions.length === 0) {
        root.appendChild(emptyBlock('No managed extensions configured.'));
        return;
      }

      for (const extension of extensions) {
        const item = document.createElement('div');
        item.className = 'provider';
        const title = document.createElement('div');
        title.className = 'provider-title';
        title.textContent = extension.label;
        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = extension.id + ' · ' + (extension.enabled ? 'enabled' : 'disabled');
        item.append(title, meta);

        if (extension.commands.length === 0) {
          item.appendChild(emptyBlock('Tracked without refresh commands. Use Hard Refresh if it owns stale diagnostics.'));
        } else {
          for (const command of extension.commands) {
            const row = document.createElement('div');
            row.className = 'command';
            const label = document.createElement('code');
            label.textContent = command;
            const remove = miniButton('Remove');
            remove.addEventListener('click', () => vscode.postMessage({ command: 'removeCommand', id: extension.id, refreshCommand: command }));
            row.append(label, remove);
            item.appendChild(row);
          }
        }

        const buttons = document.createElement('div');
        buttons.className = 'button-row';
        const toggle = miniButton(extension.enabled ? 'Disable' : 'Enable');
        const refresh = miniButton('Refresh');
        const restart = miniButton('Restart');
        const addCommand = miniButton('Add Command');
        const remove = miniButton('Remove');
        toggle.addEventListener('click', () => vscode.postMessage({ command: 'toggleExtension', id: extension.id }));
        refresh.addEventListener('click', () => vscode.postMessage({ command: 'refreshExtension', id: extension.id }));
        restart.addEventListener('click', () => vscode.postMessage({ command: 'restartExtension', id: extension.id }));
        addCommand.addEventListener('click', () => vscode.postMessage({ command: 'addCommand', id: extension.id }));
        remove.addEventListener('click', () => vscode.postMessage({ command: 'removeExtension', id: extension.id }));
        buttons.append(toggle, refresh, restart, addCommand, remove);
        item.appendChild(buttons);
        root.appendChild(item);
      }
    }

    function renderSuggestedExtensions(extensions) {
      const root = document.getElementById('suggestedExtensions');
      root.replaceChildren();
      if (extensions.length === 0) {
        root.appendChild(emptyBlock('No unmanaged diagnostic providers with refresh commands were detected.'));
        return;
      }

      for (const extension of extensions) {
        const item = document.createElement('div');
        item.className = 'provider';
        const title = document.createElement('div');
        title.className = 'provider-title';
        title.textContent = extension.label;
        const meta = document.createElement('div');
        meta.className = 'muted';
        meta.textContent = extension.id + ' · ' + extension.commands.length + ' possible commands';
        const add = miniButton('Configure');
        add.addEventListener('click', () => vscode.postMessage({ command: 'configureExtension', id: extension.id }));
        item.append(title, meta, add);
        root.appendChild(item);
      }
    }

    function renderMissingFiles(files) {
      const root = document.getElementById('missingFiles');
      root.replaceChildren();
      if (files.length === 0) {
        root.appendChild(emptyRow('No missing file diagnostics.'));
        return;
      }
      for (const file of files) {
        const row = document.createElement('li');
        const path = document.createElement('div');
        const meta = document.createElement('div');
        path.className = 'path';
        meta.className = 'muted';
        path.textContent = file.path;
        meta.textContent = file.count + ' from ' + file.sources.join(', ');
        row.append(path, meta);
        root.appendChild(row);
      }
    }

    function renderDiagnosticTasks(refreshTasksEnabled, diagnosticTasks) {
      const note = document.getElementById('tasksDisabledNote');
      const noMatch = document.getElementById('tasksNoMatch');
      const list = document.getElementById('tasksList');
      note.style.display = refreshTasksEnabled ? 'none' : '';
      if (!refreshTasksEnabled) {
        noMatch.style.display = 'none';
        list.style.display = 'none';
        return;
      }
      if (diagnosticTasks.length === 0) {
        noMatch.style.display = '';
        list.style.display = 'none';
        return;
      }
      noMatch.style.display = 'none';
      list.style.display = '';
      list.replaceChildren();
      for (const task of diagnosticTasks) {
        const row = document.createElement('li');
        const content = document.createElement('div');
        const label = document.createElement('span');
        const meta = document.createElement('span');
        label.textContent = task.name + (task.allowed ? ' ✓' : ' ✗');
        meta.className = 'muted';
        meta.textContent = task.count + ' diagnostics (matched by ' + task.matchedBy + ')' + (task.allowed ? '' : ' — not in clearedTasks');
        content.append(label, ' ', meta);
        row.appendChild(content);
        list.appendChild(row);
      }
    }

    function emptyRow(text) {
      const row = document.createElement('li');
      row.className = 'muted';
      row.textContent = text;
      return row;
    }

    function emptyBlock(text) {
      const row = document.createElement('div');
      row.className = 'muted';
      row.textContent = text;
      return row;
    }

    function miniButton(text) {
      const button = document.createElement('button');
      button.className = 'secondary mini';
      button.textContent = text;
      return button;
    }
  </script>
</body>
</html>`;
}

class ProblemsCleanerPanelDashboard {
  private panel: vscode.WebviewPanel | undefined;
  private updateSequence = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.update();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'problemsCleaner.dashboardPanel',
      'Problems Cleaner',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true
      }
    );
    this.panel.webview.html = renderDashboardHtml(this.panel.webview, this.extensionUri);
    registerDashboardMessageHandler(this.panel.webview, this.output);
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });
    void this.update();
  }

  async update(summary?: DiagnosticsSummary): Promise<void> {
    const sequence = ++this.updateSequence;
    try {
      if (!this.panel) {
        return;
      }

      const current = summary ?? await summarizeDiagnostics();
      const model = await toDashboardModel(current);
      if (sequence !== this.updateSequence || !this.panel) {
        return;
      }
      await this.panel.webview.postMessage({ type: 'model', model });
    } catch (error) {
      this.output.debug(`Dashboard panel update failed: ${String(error)}`);
    }
  }
}

let panelDashboard: ProblemsCleanerPanelDashboard | undefined;
let settingsPanel: ProblemsCleanerSettings | undefined;

class ProblemsCleanerSettings {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.LogOutputChannel
  ) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'problemsCleaner.settings',
      'Problems Cleaner Settings',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [this.extensionUri],
        retainContextWhenHidden: true
      }
    );

    this.panel.webview.html = renderSettingsHtml(this.panel.webview, this.extensionUri);
    this.panel.webview.onDidReceiveMessage((msg) => {
      void this.handleMessage(msg).catch((error) => {
        this.output.error(`Settings update failed. ${String(error)}`);
        void vscode.window.showErrorMessage('Problems Cleaner could not update that setting.');
      });
    });
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.output.info('Settings panel opened.');
  }

  private async handleMessage(message: { command: string; key?: string; value?: unknown }): Promise<void> {
    const config = vscode.workspace.getConfiguration('problemsCleaner');

    switch (message.command) {
      case 'loadSettings': {
        const data = {
          providerRefreshCommands: config.get<string[]>('providerRefreshCommands', []),
          clearedTasks: config.get<string[]>('clearedTasks', []),
          refreshTasks: config.get<boolean>('refreshTasks', false),
          refreshOnlyRelevantProviders: config.get<boolean>('refreshOnlyRelevantProviders', true),
          hardRefreshMode: config.get<'restartExtensionHost' | 'reloadWindow'>('hardRefreshMode', 'restartExtensionHost'),
          showStatusBarButton: config.get<boolean>('showStatusBarButton', true),
          saveAllBeforeRefresh: config.get<boolean>('saveAllBeforeRefresh', false),
          openProblemsAfterRefresh: config.get<boolean>('openProblemsAfterRefresh', false),
          showSetupOnFirstInstall: config.get<boolean>('showSetupOnFirstInstall', false),
          backgroundTaskWaitMs: config.get<number>('backgroundTaskWaitMs', 8000),
          taskExecutionTimeoutMs: config.get<number>('taskExecutionTimeoutMs', 120000)
        };
        await this.panel?.webview.postMessage({ type: 'settingsModel', data });
        break;
      }
      case 'updateBoolean': {
        if (typeof message.key === 'string' && SETTINGS_BOOLEAN_KEYS.has(message.key) && typeof message.value === 'boolean') {
          await config.update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
          this.output.info(`Settings: ${message.key} = ${message.value}`);
        }
        break;
      }
      case 'updateString': {
        if (message.key === 'hardRefreshMode' && (message.value === 'restartExtensionHost' || message.value === 'reloadWindow')) {
          await config.update(message.key, message.value, vscode.ConfigurationTarget.Workspace);
          this.output.info(`Settings: ${message.key} = ${message.value}`);
        }
        break;
      }
      case 'updateArray': {
        if (typeof message.key === 'string' && SETTINGS_ARRAY_KEYS.has(message.key) && Array.isArray(message.value)
          && message.value.every((item): item is string => typeof item === 'string')) {
          const value = uniqueStrings(message.value);
          await config.update(message.key, value, vscode.ConfigurationTarget.Workspace);
          this.output.info(`Settings: ${message.key} updated with ${message.value.length} item(s).`);
        }
        break;
      }
      case 'updateInteger': {
        const key = message.key;
        const value = message.value;
        const validValue = typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value)
          && (key === 'backgroundTaskWaitMs' ? value >= 1000 && value <= 60000 : key === 'taskExecutionTimeoutMs' && value >= 5000 && value <= 600000);
        if (validValue && (key === 'backgroundTaskWaitMs' || key === 'taskExecutionTimeoutMs')) {
          await config.update(key, value, vscode.ConfigurationTarget.Workspace);
          this.output.info(`Settings: ${key} = ${value}`);
        }
        break;
      }
    }
  }
}

function openSettings(extensionUri: vscode.Uri, output: vscode.LogOutputChannel): void {
  settingsPanel ??= new ProblemsCleanerSettings(extensionUri, output);
  settingsPanel.show();
}

function renderSettingsHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      margin: 0;
      padding: 20px;
    }
    h1 { font-size: 18px; margin: 0 0 20px; }
    h2 { font-size: 14px; margin: 24px 0 10px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 6px; }
    .section { margin-bottom: 20px; }
    .field { margin-bottom: 12px; }
    .field label { display: block; font-weight: 600; margin-bottom: 4px; }
    .desc { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
    .row { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
    input[type="text"], select {
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      padding: 4px 8px;
      width: 100%;
      box-sizing: border-box;
    }
    input[type="text"]:focus, select:focus {
      border-color: var(--vscode-focusBorder);
      outline: none;
    }
    input[type="checkbox"] { margin: 0; }
    button {
      background: var(--vscode-button-background);
      border: 1px solid var(--vscode-button-border, transparent);
      color: var(--vscode-button-foreground);
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      line-height: 1.4;
      padding: 4px 10px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); border-color: var(--vscode-inputValidation-errorBorder); }
    .item-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
    .item-row span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--vscode-editor-font-family); font-size: 12px; }
    .add-row { margin-top: 8px; }
    .status { color: var(--vscode-inputValidation-infoForeground); font-size: 12px; margin-top: 4px; min-height: 18px; }
  </style>
</head>
<body>
  <h1>Problems Cleaner Settings</h1>
  <p class="desc">Defaults are conservative: no provider restart, task restart, editor opening, or host restart happens unless configured and explicitly requested.</p>

  <div class="section">
    <h2>Diagnostic Provider Commands</h2>
    <p class="desc">Command IDs run during soft refresh to restart language servers and linters.</p>
    <div id="providerCommands"></div>
    <div class="add-row">
      <div class="row">
        <input type="text" id="newProviderCommand" placeholder="e.g. eslint.restart" style="flex:1">
        <button id="addProviderCommand">Add</button>
      </div>
    </div>
    <div class="status" id="providerStatus"></div>
  </div>

  <div class="section">
    <h2>Cleared Tasks</h2>
    <p class="desc">Task names that Clear Problems is allowed to kill and restart. Must match task labels from tasks.json exactly.</p>
    <div id="clearedTasksList"></div>
    <div class="add-row">
      <div class="row">
        <input type="text" id="newClearedTask" placeholder="e.g. tsc: watch - tsconfig.json" style="flex:1">
        <button id="addClearedTask">Add</button>
      </div>
    </div>
    <div class="status" id="clearedTasksStatus"></div>
  </div>

  <div class="section">
    <h2>Behavior</h2>
    <div class="field">
      <label><input type="checkbox" id="refreshTasks"> Re-execute tasks during Refresh Problems</label>
      <p class="desc">When enabled, Refresh Problems will also re-execute workspace tasks whose problemMatchers generated current diagnostics.</p>
    </div>
    <div class="field">
      <label><input type="checkbox" id="refreshOnlyRelevantProviders"> Only refresh providers matching current diagnostics</label>
      <p class="desc">Recommended. Prevents unrelated language servers and linters from restarting or making requests.</p>
    </div>
    <div class="field">
      <label><input type="checkbox" id="showStatusBarButton"> Show status bar button</label>
    </div>
    <div class="field">
      <label><input type="checkbox" id="saveAllBeforeRefresh"> Save all files before refresh</label>
    </div>
    <div class="field">
      <label><input type="checkbox" id="openProblemsAfterRefresh"> Open Problems panel after refresh</label>
    </div>
    <div class="field">
      <label><input type="checkbox" id="showSetupOnFirstInstall"> Prompt setup on first install</label>
    </div>
    <div class="field">
      <label for="hardRefreshMode">Hard refresh strategy</label>
      <select id="hardRefreshMode">
        <option value="restartExtensionHost">Restart Extension Host</option>
        <option value="reloadWindow">Reload Window</option>
      </select>
      <p class="desc">Restart Extension Host is less disruptive. Reload Window is the fallback.</p>
    </div>
  </div>

  <div class="section">
    <h2>Timing</h2>
    <div class="field">
      <label for="backgroundTaskWaitMs">Background task wait (ms)</label>
      <input type="number" id="backgroundTaskWaitMs" min="1000" max="60000" step="500">
      <p class="desc">How long to wait for a background/watch task to publish diagnostics after restart. Increase if your build system takes longer to produce initial output.</p>
    </div>
    <div class="field">
      <label for="taskExecutionTimeoutMs">Task execution timeout (ms)</label>
      <input type="number" id="taskExecutionTimeoutMs" min="5000" max="600000" step="1000">
      <p class="desc">Maximum time to wait for a non-background task to finish during Clear Problems or Refresh Problems.</p>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      if (event.data.type !== 'settingsModel') { return; }
      const d = event.data.data;

      document.getElementById('refreshTasks').checked = d.refreshTasks;
      document.getElementById('refreshOnlyRelevantProviders').checked = d.refreshOnlyRelevantProviders;
      document.getElementById('showStatusBarButton').checked = d.showStatusBarButton;
      document.getElementById('saveAllBeforeRefresh').checked = d.saveAllBeforeRefresh;
      document.getElementById('openProblemsAfterRefresh').checked = d.openProblemsAfterRefresh;
      document.getElementById('showSetupOnFirstInstall').checked = d.showSetupOnFirstInstall;
      document.getElementById('hardRefreshMode').value = d.hardRefreshMode;
      document.getElementById('backgroundTaskWaitMs').value = d.backgroundTaskWaitMs;
      document.getElementById('taskExecutionTimeoutMs').value = d.taskExecutionTimeoutMs;

      renderArrayItems('providerCommands', d.providerRefreshCommands, 'providerCommands');
      renderArrayItems('clearedTasksList', d.clearedTasks, 'clearedTasks');
    });

    function renderArrayItems(containerId, items, configKey) {
      const container = document.getElementById(containerId);
      container.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'desc';
        empty.textContent = 'No entries.';
        container.appendChild(empty);
        return;
      }
      for (let i = 0; i < items.length; i++) {
        const row = document.createElement('div');
        row.className = 'item-row';
        const span = document.createElement('span');
        span.textContent = items[i];
        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger';
        removeBtn.textContent = '✕';
        removeBtn.title = 'Remove';
        (function(idx) {
          removeBtn.addEventListener('click', () => {
            const updated = items.filter((_, j) => j !== idx);
            vscode.postMessage({ command: 'updateArray', key: configKey, value: updated });
            renderArrayItems(containerId, updated, configKey);
          });
        })(i);
        row.append(span, removeBtn);
        container.appendChild(row);
      }
    }

    function addItem(inputId, containerId, configKey, statusId) {
      const input = document.getElementById(inputId);
      const value = input.value.trim();
      if (!value) { return; }
      const items = Array.from(document.getElementById(containerId).querySelectorAll('.item-row span')).map(s => s.textContent);
      items.push(value);
      vscode.postMessage({ command: 'updateArray', key: configKey, value: items });
      const status = document.getElementById(statusId);
      status.textContent = 'Added ' + value;
      setTimeout(() => { status.textContent = ''; }, 2000);
      input.value = '';
      renderArrayItems(containerId, items, configKey);
    }

    document.getElementById('addProviderCommand').addEventListener('click', () => {
      addItem('newProviderCommand', 'providerCommands', 'providerRefreshCommands', 'providerStatus');
    });
    document.getElementById('addClearedTask').addEventListener('click', () => {
      addItem('newClearedTask', 'clearedTasksList', 'clearedTasks', 'clearedTasksStatus');
    });

    document.getElementById('refreshTasks').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'refreshTasks', value: this.checked });
    });
    document.getElementById('refreshOnlyRelevantProviders').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'refreshOnlyRelevantProviders', value: this.checked });
    });
    document.getElementById('showStatusBarButton').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'showStatusBarButton', value: this.checked });
    });
    document.getElementById('saveAllBeforeRefresh').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'saveAllBeforeRefresh', value: this.checked });
    });
    document.getElementById('openProblemsAfterRefresh').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'openProblemsAfterRefresh', value: this.checked });
    });
    document.getElementById('showSetupOnFirstInstall').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateBoolean', key: 'showSetupOnFirstInstall', value: this.checked });
    });
    document.getElementById('hardRefreshMode').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateString', key: 'hardRefreshMode', value: this.value });
    });
    document.getElementById('backgroundTaskWaitMs').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateInteger', key: 'backgroundTaskWaitMs', value: parseInt(this.value, 10) });
    });
    document.getElementById('taskExecutionTimeoutMs').addEventListener('change', function() {
      vscode.postMessage({ command: 'updateInteger', key: 'taskExecutionTimeoutMs', value: parseInt(this.value, 10) });
    });

    vscode.postMessage({ command: 'loadSettings' });
  </script>
</body>
</html>`;
}

function registerDashboardMessageHandler(webview: vscode.Webview, output: vscode.LogOutputChannel): void {
  webview.onDidReceiveMessage((message: { command?: string; id?: string; refreshCommand?: string }) => {
    switch (message.command) {
      case 'refresh':
        void refreshProblems(output, 'dashboard', true);
        break;
      case 'hardRefresh':
        void hardRefreshProblems(output);
        break;
      case 'clearProblems':
        void clearProblems(output);
        break;
      case 'openSettings':
        if (extensionContext) {
          openSettings(extensionContext.extensionUri, output);
        }
        break;
      case 'report':
        void showDiagnosticsReport(output);
        break;
      case 'copyAllProblems':
        void copyAllProblems(output);
        break;
      case 'setup':
        void vscode.commands.executeCommand('problemsCleaner.setup');
        break;
      case 'addExtension':
        void addExtensionByPicker(output);
        break;
      case 'manageExtensions':
        void vscode.commands.executeCommand('workbench.view.extensions');
        break;
      case 'toggleExtension':
        if (message.id) {
          void toggleManagedExtension(message.id);
        }
        break;
      case 'removeExtension':
        if (message.id) {
          void removeManagedExtension(message.id);
        }
        break;
      case 'addCommand':
        if (message.id) {
          void addCommandToManagedExtension(message.id);
        }
        break;
      case 'refreshExtension':
        if (message.id) {
          void refreshManagedProviderById(message.id, output);
        }
        break;
      case 'restartExtension':
        if (message.id) {
          void hardRefreshManagedProviderById(message.id, output);
        }
        break;
      case 'configureExtension':
        if (message.id) {
          void configureExtensionById(message.id, output);
        }
        break;
      case 'removeCommand':
        if (message.id && message.refreshCommand) {
          void removeManagedCommand(message.id, message.refreshCommand);
        }
        break;
    }
  });
}

async function toDashboardModel(summary: DiagnosticsSummary): Promise<unknown> {
  const managedExtensions = getManagedExtensions();
  const suggestions = (await discoverExtensionCandidates())
    .filter((candidate) => !candidate.managed && candidate.autoScore > 0 && candidate.commands.length > 0)
    .slice(0, 8);

  const config = vscode.workspace.getConfiguration('problemsCleaner');
  const refreshTasksEnabled = config.get<boolean>('refreshTasks', false);
  const refreshOnlyRelevantProviders = config.get<boolean>('refreshOnlyRelevantProviders', true);
  const configuredProviderCommands = getConfiguredRefreshCommands();
  const relevantProviderCommands = refreshOnlyRelevantProviders
    ? selectRelevantProviderCommands(configuredProviderCommands, summary.bySource.keys())
    : configuredProviderCommands;
  const clearedTaskNames = getAllowedTaskNames();
  let diagnosticTasks: { name: string; source: string; count: number; matchedBy: string; allowed: boolean }[] = [];

  if (refreshTasksEnabled) {
    const tasks = await fetchDiagnosticTasks();
    diagnosticTasks = tasks.map((entry) => ({
      name: entry.task.name,
      source: entry.source,
      count: entry.diagnosticCount,
      matchedBy: entry.matchedBy,
      allowed: clearedTaskNames.some((n) => n.toLowerCase() === entry.task.name.toLowerCase())
    }));
  }

  return {
    summary: {
      total: summary.total,
      missingFiles: summary.missingFiles,
      bySeverity: summary.bySeverity,
      sources: [...summary.bySource.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([source, count]) => ({ source, count })),
      missingFileResources: summary.missingFileResources.slice(0, 8).map((resource) => ({
        path: resource.uri.fsPath,
        count: resource.count,
        sources: resource.sources
      }))
    },
    managedExtensions: managedExtensions.map((extension) => ({
      id: extension.id,
      label: extension.label ?? extension.id,
      enabled: extension.enabled !== false,
      commands: extension.commands,
      autoDiscovered: extension.autoDiscovered === true
    })),
    suggestedExtensions: suggestions.map((extension) => ({
      id: extension.id,
      label: extension.label,
      commands: extension.commands
    })),
    refreshTasksEnabled,
    diagnosticTasks,
    refreshPlan: {
      onlyRelevantProviders: refreshOnlyRelevantProviders,
      configuredProviderCount: configuredProviderCommands.length,
      relevantProviderCount: relevantProviderCommands.length,
      diagnosticSourceCount: summary.bySource.size
    }
  };
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';

  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }

  return text;
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
  statusBar.tooltip = createStatusBarTooltip();
  statusBar.command = 'problemsCleaner.refreshProblems';
  statusBar.show();
  context.subscriptions.push(statusBar);
  scheduleStatusBarUpdate();
}

function setupDiagnosticsStatusUpdates(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.languages.onDidChangeDiagnostics(() => scheduleStatusBarUpdate())
  );
  scheduleStatusBarUpdate();
}

function scheduleStatusBarUpdate(): void {
  if (!statusBar) {
    return;
  }

  if (statusUpdateTimer) {
    clearTimeout(statusUpdateTimer);
  }

  statusUpdateTimer = setTimeout(() => {
    void summarizeDiagnostics().then((summary) => {
      updateStatusBar(summary);
      dashboard?.update(summary);
      panelDashboard?.update(summary);
    });
  }, 300);
}

function updateStatusBar(summary?: DiagnosticsSummary): void {
  if (!statusBar) {
    return;
  }

  if (summary) {
    lastDiagnosticsSummary = summary;
  }

  const current = summary ?? lastDiagnosticsSummary;

  if (activeOperation) {
    statusBar.text = `$(sync~spin) ${activeOperation.label}`;
    statusBar.tooltip = createStatusBarTooltip(current);
    return;
  }

  if (!current) {
    statusBar.text = '$(refresh) Problems';
    statusBar.tooltip = createStatusBarTooltip();
    return;
  }

  statusBar.text = current.missingFiles > 0
    ? `$(refresh) Problems: ${current.total} (${current.missingFiles} stale?)`
    : `$(refresh) Problems: ${current.total}`;
  statusBar.tooltip = createStatusBarTooltip(current);
}

function createStatusBarTooltip(summary?: DiagnosticsSummary): vscode.MarkdownString {
  const lines = [
    '$(refresh) **Problems Cleaner**',
    '',
    summary
      ? `${summary.total} diagnostics reported. ${summary.missingFiles} point at missing files.`
      : 'Refresh stale Problems diagnostics.',
    '',
    '[$(refresh) Refresh Problems](command:problemsCleaner.refreshProblems)',
    '[$(list-unordered) Show Report](command:problemsCleaner.showDiagnosticsReport)',
    '[$(copy) Copy All Problems](command:problemsCleaner.copyAllProblems)',
    '[$(settings-gear) Settings](command:problemsCleaner.setup)',
    '[$(debug-restart) Hard Refresh](command:problemsCleaner.hardRefreshProblems)'
  ];

  if (activeOperation) {
    lines.push('', `[$(circle-slash) Cancel ${activeOperation.label}](command:problemsCleaner.cancelOperation)`);
  }

  const tooltip = new vscode.MarkdownString(lines.join('\n\n'), true);
  tooltip.isTrusted = {
    enabledCommands: [
      'problemsCleaner.refreshProblems',
      'problemsCleaner.showDiagnosticsReport',
      'problemsCleaner.copyAllProblems',
      'problemsCleaner.setup',
      'problemsCleaner.cancelOperation',
      'problemsCleaner.hardRefreshProblems'
    ]
  };
  return tooltip;
}

async function withCancellableOperation(
  label: string,
  output: vscode.LogOutputChannel,
  options: Omit<vscode.ProgressOptions, 'cancellable'>,
  operation: (progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken) => Promise<void>
): Promise<void> {
  if (activeOperation) {
    void vscode.window.showWarningMessage(`${activeOperation.label} is already running. Cancel it before starting another Problems Cleaner operation.`);
    return;
  }

  const cancellation = new vscode.CancellationTokenSource();
  activeOperation = { label, cancellation };
  updateStatusBar();

  try {
    await vscode.window.withProgress(
      { ...options, cancellable: true },
      async (progress, progressToken) => {
        const subscription = progressToken.onCancellationRequested(() => cancelActiveOperation(output));
        try {
          await operation(progress, cancellation.token);
        } finally {
          subscription.dispose();
        }
      }
    );
  } catch (error) {
    if (!isOperationCancelledError(error)) {
      output.error(`${label} failed. ${String(error)}`);
      void vscode.window.showErrorMessage(`${label} failed. Check the Problems Cleaner output for details.`);
      return;
    }

    output.info(`${label} cancelled.`);
    vscode.window.setStatusBarMessage(`$(circle-slash) ${label} cancelled.`, 5000);
  } finally {
    if (activeOperation?.cancellation === cancellation) {
      activeOperation = undefined;
    }
    cancellation.dispose();
    updateStatusBar();
  }
}

function cancelActiveOperation(output?: vscode.LogOutputChannel): void {
  if (!activeOperation) {
    void vscode.window.showInformationMessage('No Problems Cleaner operation is running.');
    return;
  }

  const { label, cancellation } = activeOperation;
  if (!cancellation.token.isCancellationRequested) {
    output?.info(`Cancellation requested for ${label}.`);
    vscode.window.setStatusBarMessage(`$(circle-slash) Cancelling ${label}...`, 3000);
    cancellation.cancel();
    updateStatusBar();
  }
}

function throwIfCancelled(token: vscode.CancellationToken | undefined, label: string): void {
  if (token?.isCancellationRequested) {
    throw new OperationCancelledError(label);
  }
}

function isOperationCancelledError(error: unknown): error is OperationCancelledError {
  return error instanceof OperationCancelledError;
}

async function safeExecute(command: string, output: vscode.LogOutputChannel): Promise<boolean> {
  try {
    output.debug(`Executing command: ${command}`);
    await vscode.commands.executeCommand(command);
    return true;
  } catch (error) {
    output.debug(`Command failed or unavailable: ${command}. ${String(error)}`);
    return false;
  }
}

function sleep(ms: number, token?: vscode.CancellationToken, label = 'Operation'): Promise<void> {
  throwIfCancelled(token, label);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      subscription.dispose();
      resolve();
    }, ms);
    const subscription = token?.onCancellationRequested(() => {
      clearTimeout(timeout);
      subscription.dispose();
      reject(new OperationCancelledError(label));
    }) ?? { dispose: () => undefined };
  });
}
