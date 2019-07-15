import * as vscode from 'vscode';

import { Errorable, failed } from './errorable';

export async function selectWorkspaceFolder(placeHolder?: string): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders;

    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage("This command requires an open folder");
        return undefined;
    }

    if (folders.length === 1) {
        return folders[0];
    }

    return await vscode.window.showWorkspaceFolderPick({ placeHolder: placeHolder });
}

export async function selectQuickPick<T extends vscode.QuickPickItem>(items: T[], options?: vscode.QuickPickOptions): Promise<T | undefined> {
    if (items.length === 1) {
        return items[0];
    }
    return await vscode.window.showQuickPick(items, options);
}

export async function longRunning<T>(title: string, action: () => Promise<T>): Promise<T> {
    const options = {
        location: vscode.ProgressLocation.Notification,
        title: title
    };
    return await vscode.window.withProgress(options, (_) => action());
}

export async function longRunningWithMessages<T>(title: string, action: () => (Promise<unknown>)[]): Promise<T | undefined> {
    const options = {
        location: vscode.ProgressLocation.Notification,
        title: title
    };
    async function runAction(progress: vscode.Progress<{ message?: string; increment?: number}>, _token: vscode.CancellationToken): Promise<T | undefined> {
        for (const a of action()) {
            const progressInfo = await a;
            if (progressInfo.type === 'update') {
                progress.report({ message: progressInfo.message });
            } else if (progressInfo.type === 'complete') {
                return progressInfo.value;
            }
        }
        return undefined;
    }
    return await vscode.window.withProgress(options, runAction);
}

export async function showDuffleResult<T>(command: string, resource: string | ((r: T) => string), duffleResult: Errorable<T>): Promise<void> {
    if (failed(duffleResult)) {
        // The invocation infrastructure adds blurb about what command failed, and
        // Duffle's CLI parser adds 'Error:'. We don't need that here because we're
        // going to prepend our own blurb.
        const message = trimPrefix(duffleResult.error[0], `duffle ${command} error: Error:`).trim();
        await vscode.window.showErrorMessage(`Duffle ${command} failed: ${message}`);
    } else {
        const resourceText = resource instanceof Function ? resource(duffleResult.result) : resource;
        await vscode.window.showInformationMessage(`Duffle ${command} complete for ${resourceText}`);
    }
}

function trimPrefix(text: string, prefix: string): string {
    if (text.startsWith(prefix)) {
        return text.substring(prefix.length);
    }
    return text;
}

export async function confirm(text: string, confirmLabel: string): Promise<boolean> {
    const choice = await vscode.window.showWarningMessage(text, confirmLabel, 'Cancel');
    return choice === confirmLabel;
}

export async function refreshInstallationExplorer(): Promise<void> {
    await vscode.commands.executeCommand("duffle.refreshInstallationExplorer");
}

export async function refreshBundleExplorer(): Promise<void> {
    await vscode.commands.executeCommand("duffle.refreshBundleExplorer");
}

export async function refreshRepoExplorer(): Promise<void> {
    await vscode.commands.executeCommand("duffle.refreshRepoExplorer");
}

export async function refreshCredentialExplorer(): Promise<void> {
    await vscode.commands.executeCommand("duffle.refreshCredentialExplorer");
}
