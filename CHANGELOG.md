# What’s new

## 0.2.0

### Safer refresh behavior

- **Refresh Problems** no longer restarts every configured provider.
- Provider commands are opt-in and are matched to current diagnostic sources by default.
- Normal refresh does not open editors, focus the Problems view, restart the Extension Host, or reload the window.
- Provider discovery is opt-in instead of opening setup during activation.
- Extension and provider discovery is cached to reduce background work when diagnostics change.

### Better cleanup controls

- **Clear Allowed Tasks** stops and restarts only tasks explicitly listed in `clearedTasks`.
- Duplicate task matches no longer cause repeated task restarts.
- Fast task completion, cancellation, and timeout cleanup are handled safely.
- Provider-wide restart is separated from normal provider refresh and requires confirmation.
- Restart actions are blocked while another operation is running unless they are the explicit fallback of that operation.

### Improved experience

- Added **Copy All Problems** to the Problems view toolbar, dashboard, command palette, and status-bar hover menu.
- Copied diagnostics include resource, severity, source, range, code, and message for quick sharing or issue reports.
- The sidebar explains what a refresh will run before you click it.
- Actions now distinguish safe refresh, task cleanup, provider scanning, and host restart.
- Dashboard sections are collapsible and show clearer diagnostics, provider, and task status.
- Repeated clicks are visually guarded while an action is being submitted.
- Settings updates are validated and restricted to supported Problems Cleaner settings.
- Settings and dashboard panels avoid duplicate windows and stale out-of-order updates.
- README documentation is organized around user workflows and limitations.

## 0.1.2

- Diagnostic counts and dashboard information now update when VS Code publishes new diagnostics.
- Manual refresh respects the setting that controls whether the Problems view receives focus.

## 0.1.1

- Added cancellable refresh operations.
- Added status-bar access to Settings and cancellation.
- Prevented overlapping Problems Cleaner refresh operations.
- Added the Problems Cleaner view icon.

## 0.1.0

- Initial release with manual diagnostics refresh, provider setup, per-provider actions, reports, dashboard UI, and theme-aware icons.
