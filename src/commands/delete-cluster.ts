import * as vscode from 'vscode';

export async function onDeleteCluster(target?: any): Promise<void> {
    await vscode.window.showInformationMessage(`exterminate ${target}`);
}
