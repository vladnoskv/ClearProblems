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

const EXTENSION_NAME = 'Problems Cleaner';
const SETUP_STATE_KEY = 'problemsCleaner.setupPromptShown';
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
let statusBar: vscode.StatusBarItem | undefined;
let refreshTimer: NodeJS.Timeout | undefined;
let statusUpdateTimer: NodeJS.Timeout | undefined;
let dashboard: ProblemsCleanerDashboard | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel(EXTENSION_NAME, { log: true });
  dashboard = new ProblemsCleanerDashboard(context.extensionUri, output);

  context.subscriptions.push(
    output,
    vscode.window.registerWebviewViewProvider('problemsCleaner.dashboard', dashboard),
    vscode.commands.registerCommand('problemsCleaner.refreshProblems', () => refreshProblems(output, 'manual', true)),
    vscode.commands.registerCommand('problemsCleaner.hardRefreshProblems', () => hardRefreshProblems(output)),
    vscode.commands.registerCommand('problemsCleaner.showDiagnosticsReport', () => showDiagnosticsReport(output)),
    vscode.commands.registerCommand('problemsCleaner.setup', () => runSetup(context, output, true)),
    vscode.commands.registerCommand('problemsCleaner.manageExtensions', () => openManager()),
    vscode.commands.registerCommand('problemsCleaner.addExtensionFromContext', (item) => addExtensionFromContext(item, output))
  );

  setupStatusBar(context);
  setupWorkspaceWatchers(context, output);
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
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  if (statusUpdateTimer) {
    clearTimeout(statusUpdateTimer);
  }
}

async function refreshProblems(output: vscode.LogOutputChannel, reason: string, showNotification = false): Promise<void> {
  await vscode.window.withProgress(
    {
      location: showNotification ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window,
      title: 'Problems Cleaner',
      cancellable: false
    },
    async (progress) => {
      await refreshProblemsCore(output, reason, progress, showNotification);
    }
  );
}

async function refreshProblemsCore(output: vscode.LogOutputChannel, reason: string, progress: vscode.Progress<{ message?: string }>, showNotification: boolean): Promise<void> {
  progress.report({ message: 'Reading diagnostics...' });
  const before = await summarizeDiagnostics();
  output.info(`Soft refresh started. Reason=${reason}. Current diagnostics=${before.total}. Missing-file diagnostics=${before.missingFiles}.`);

  const config = vscode.workspace.getConfiguration('problemsCleaner');

  if (config.get<boolean>('saveAllBeforeRefresh', false)) {
    progress.report({ message: 'Saving open files...' });
    await vscode.workspace.saveAll(false);
  }

  progress.report({ message: 'Restarting diagnostic providers...' });
  const commands = await runConfiguredProviderCommands(output);
  progress.report({ message: 'Refreshing visible documents...' });
  await pokeOpenDocuments(output);

  // Give language servers and linters a short turn to republish diagnostics.
  progress.report({ message: 'Waiting for diagnostics to republish...' });
  await sleep(600);

  const after = await summarizeDiagnostics();
  updateStatusBar(after);
  dashboard?.update(after);
  output.info(`Soft refresh finished. Before=${before.total}. After=${after.total}. Missing-file diagnostics=${after.missingFiles}. Commands executed=${commands.executed.length}. Skipped=${commands.skipped.length}. Failed=${commands.failed.length}.`);

  if (config.get<boolean>('openProblemsAfterRefresh', true)) {
    await safeExecute('workbench.actions.view.problems', output);
  }

  const message = after.missingFiles > 0
    ? `Refresh requested. ${after.total} diagnostics remain; ${after.missingFiles} still point at missing files. Use Hard Refresh if they are stale.`
    : `Refresh requested. ${after.total} diagnostics currently reported.`;

  vscode.window.setStatusBarMessage(`$(refresh) ${message}`, 5000);
  if (showNotification) {
    void vscode.window.showInformationMessage(message);
  }
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

async function runConfiguredProviderCommands(output: vscode.LogOutputChannel): Promise<CommandRunSummary> {
  const configured = getConfiguredRefreshCommands();

  const available = new Set(await vscode.commands.getCommands(true));
  const summary: CommandRunSummary = {
    executed: [],
    skipped: [],
    failed: []
  };

  for (const command of configured) {
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
  }

  return summary;
}

function getConfiguredRefreshCommands(): string[] {
  const config = vscode.workspace.getConfiguration('problemsCleaner');
  const legacyCommands = config.get<string[]>('providerRefreshCommands', []);
  const managedCommands = getManagedExtensions()
    .filter((extension) => extension.enabled !== false)
    .flatMap((extension) => extension.commands);

  return uniqueStrings([...legacyCommands, ...managedCommands]);
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
  if (!config.get<boolean>('showSetupOnFirstInstall', true) || context.globalState.get<boolean>(SETUP_STATE_KEY)) {
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
    openManager();
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
    openManager();
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
  void vscode.window.showInformationMessage(`Problems Cleaner added ${picked.length} extension provider${picked.length === 1 ? '' : 's'} to refresh.`);
  openManager();
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
  void vscode.window.showInformationMessage(`Added ${getExtensionLabel(extension)} to Problems Refresh.`);
  openManager();
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
  const managedIds = new Set(getManagedExtensions().map((extension) => extension.id.toLowerCase()));
  const candidates = await Promise.all(
    vscode.extensions.all
      .filter((extension) => extension.id !== 'predictduel.vscode-problems-cleaner')
      .map(async (extension) => {
        const commands = await getRefreshCommandCandidatesForExtension(extension);
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

  return candidates.sort((a, b) => {
    if (a.managed !== b.managed) {
      return a.managed ? 1 : -1;
    }
    return b.autoScore - a.autoScore || a.label.localeCompare(b.label);
  });
}

async function getRefreshCommandCandidatesForExtension(extension: vscode.Extension<unknown>): Promise<string[]> {
  const allCommands = await vscode.commands.getCommands(true);
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
  return vscode.workspace
    .getConfiguration('problemsCleaner')
    .get<ManagedExtensionConfig[]>('managedExtensions', [])
    .filter((extension) => typeof extension.id === 'string' && Array.isArray(extension.commands));
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
}

async function updateManagedExtensions(entries: ManagedExtensionConfig[]): Promise<void> {
  await vscode.workspace
    .getConfiguration('problemsCleaner')
    .update('managedExtensions', entries, vscode.ConfigurationTarget.Global);
}

async function removeManagedExtension(id: string): Promise<void> {
  await updateManagedExtensions(getManagedExtensions().filter((extension) => extension.id.toLowerCase() !== id.toLowerCase()));
  dashboard?.refreshModel();
}

async function toggleManagedExtension(id: string): Promise<void> {
  const entries = getManagedExtensions().map((extension) => extension.id.toLowerCase() === id.toLowerCase()
    ? { ...extension, enabled: extension.enabled === false }
    : extension);
  await updateManagedExtensions(entries);
  dashboard?.refreshModel();
}

async function removeManagedCommand(id: string, command: string): Promise<void> {
  const entries = getManagedExtensions().map((extension) => extension.id.toLowerCase() === id.toLowerCase()
    ? { ...extension, commands: extension.commands.filter((candidate) => candidate !== command) }
    : extension);
  await updateManagedExtensions(entries);
  dashboard?.refreshModel();
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
}

function openManager(): void {
  void vscode.commands.executeCommand('workbench.view.extension.problemsCleaner');
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
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((message: { command?: string }) => {
      switch (message.command) {
        case 'refresh':
          void refreshProblems(this.output, 'dashboard', true);
          break;
        case 'hardRefresh':
          void hardRefreshProblems(this.output);
          break;
        case 'report':
          void showDiagnosticsReport(this.output);
          break;
        case 'setup':
          void vscode.commands.executeCommand('problemsCleaner.setup');
          break;
        case 'addExtension':
          void addExtensionByPicker(this.output);
          break;
        case 'manageExtensions':
          void vscode.commands.executeCommand('workbench.view.extensions');
          break;
      }
    });

    view.webview.onDidReceiveMessage((message: { command?: string; id?: string; refreshCommand?: string }) => {
      if (!message.id) {
        return;
      }

      switch (message.command) {
        case 'toggleExtension':
          void toggleManagedExtension(message.id);
          break;
        case 'removeExtension':
          void removeManagedExtension(message.id);
          break;
        case 'addCommand':
          void addCommandToManagedExtension(message.id);
          break;
        case 'configureExtension':
          void configureExtensionById(message.id, this.output);
          break;
        case 'removeCommand':
          if (message.refreshCommand) {
            void removeManagedCommand(message.id, message.refreshCommand);
          }
          break;
      }
    });

    void this.update();
  }

  async update(summary?: DiagnosticsSummary): Promise<void> {
    if (!this.view) {
      return;
    }

    const current = summary ?? await summarizeDiagnostics();
    await this.view.webview.postMessage({
      type: 'model',
      model: await toDashboardModel(current)
    });
  }

  refreshModel(): void {
    void this.update();
  }

  private render(webview: vscode.Webview): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      padding: 14px;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .actions {
      display: grid;
      gap: 8px;
      margin-bottom: 16px;
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
      min-height: 30px;
      padding: 5px 10px;
      width: 100%;
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
      border: 1px solid var(--vscode-panel-border);
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
      border: 1px solid var(--vscode-panel-border);
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
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    .button-row button {
      flex: 1;
    }
    .muted {
      color: var(--vscode-descriptionForeground);
    }
    .path {
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <div class="actions">
    <button id="refresh">Refresh Problems</button>
    <button id="report" class="secondary">Show Diagnostics Report</button>
    <button id="setup" class="secondary">Setup Providers</button>
    <button id="addExtension" class="secondary">Add Installed Extension</button>
    <button id="hardRefresh" class="secondary">Hard Refresh</button>
  </div>

  <div class="stats">
    <div class="stat"><span id="total" class="value">0</span><span class="label">Diagnostics</span></div>
    <div class="stat"><span id="missing" class="value">0</span><span class="label">Missing files</span></div>
    <div class="stat"><span id="errors" class="value">0</span><span class="label">Errors</span></div>
    <div class="stat"><span id="warnings" class="value">0</span><span class="label">Warnings</span></div>
  </div>

  <h2>Top Sources</h2>
  <ul id="sources"><li class="muted">No diagnostics reported.</li></ul>

  <h2>Managed Extensions</h2>
  <div id="managedExtensions"><div class="muted">No managed extensions configured.</div></div>

  <h2>Suggested Extensions</h2>
  <div id="suggestedExtensions"><div class="muted">No suggestions found.</div></div>

  <h2>Missing File Diagnostics</h2>
  <ul id="missingFiles"><li class="muted">No missing file diagnostics.</li></ul>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('report').addEventListener('click', () => vscode.postMessage({ command: 'report' }));
    document.getElementById('setup').addEventListener('click', () => vscode.postMessage({ command: 'setup' }));
    document.getElementById('addExtension').addEventListener('click', () => vscode.postMessage({ command: 'addExtension' }));
    document.getElementById('hardRefresh').addEventListener('click', () => vscode.postMessage({ command: 'hardRefresh' }));

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
        const addCommand = miniButton('Add Command');
        const remove = miniButton('Remove');
        toggle.addEventListener('click', () => vscode.postMessage({ command: 'toggleExtension', id: extension.id }));
        addCommand.addEventListener('click', () => vscode.postMessage({ command: 'addCommand', id: extension.id }));
        remove.addEventListener('click', () => vscode.postMessage({ command: 'removeExtension', id: extension.id }));
        buttons.append(toggle, addCommand, remove);
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
}

async function toDashboardModel(summary: DiagnosticsSummary): Promise<unknown> {
  const managedExtensions = getManagedExtensions();
  const suggestions = (await discoverExtensionCandidates())
    .filter((candidate) => !candidate.managed && candidate.autoScore > 0 && candidate.commands.length > 0)
    .slice(0, 8);

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
    }))
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
    });
  }, 300);
}

function updateStatusBar(summary?: DiagnosticsSummary): void {
  if (!statusBar) {
    return;
  }

  if (!summary) {
    statusBar.text = '$(refresh) Problems';
    statusBar.tooltip = createStatusBarTooltip();
    return;
  }

  statusBar.text = summary.missingFiles > 0
    ? `$(refresh) Problems: ${summary.total} (${summary.missingFiles} stale?)`
    : `$(refresh) Problems: ${summary.total}`;
  statusBar.tooltip = createStatusBarTooltip(summary);
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
    '[$(extensions) Manage Extensions](command:problemsCleaner.manageExtensions)',
    '[$(gear) Setup Providers](command:problemsCleaner.setup)',
    '[$(debug-restart) Hard Refresh](command:problemsCleaner.hardRefreshProblems)'
  ];

  const tooltip = new vscode.MarkdownString(lines.join('\n\n'), true);
  tooltip.isTrusted = {
    enabledCommands: [
      'problemsCleaner.refreshProblems',
      'problemsCleaner.showDiagnosticsReport',
      'problemsCleaner.manageExtensions',
      'problemsCleaner.setup',
      'problemsCleaner.hardRefreshProblems'
    ]
  };
  return tooltip;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
