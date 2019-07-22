import * as vscode from 'vscode';
import * as k8s from 'vscode-kubernetes-tools-api';

import * as kind from '../kind/kind';
import * as kindCloudProvider from '../kind-cloud-provider';
import { shell } from '../utils/shell';
import { failed, Errorable, succeeded } from '../utils/errorable';
import { longRunning, confirm } from '../utils/host';
import { KindCloudProviderTreeNode, KindCloudProviderClusterNode } from '../kind-cloud-provider';

export async function onDeleteCluster(target?: any): Promise<void> {
    if (target) {
        await deleteCluster(target);
    } else {
        await deleteClusterInteractive();
    }
}

async function deleteCluster(target: any): Promise<void> {
    const clusterNode = await tryResolveClusterNode(target);
    if (!clusterNode) {
        return;  // should never happen
    }
    await deleteClusterByName(clusterNode.clusterName);
}

async function deleteClusterInteractive(): Promise<void> {
    const clusterName = await promptCluster('Getting existing clusters...');
    if (!clusterName) {
        return;
    }
    await deleteClusterByName(clusterName);
}

async function deleteClusterByName(clusterName: string): Promise<void> {
    const confirmed = await confirm(`This will delete ${clusterName}. You will not be able to undo this.`, 'Delete Cluster');
    if (!confirmed) {
        return;
    }
    const result = await longRunning(`Deleting cluster ${clusterName}...`, () => kind.deleteCluster(shell, clusterName));
    // TODO: remove from kubeconfig?
    await displayClusterDeletionResult(result, clusterName);
}

async function displayClusterDeletionResult(result: Errorable<null>, clusterName: string): Promise<void> {
    if (succeeded(result)) {
        await Promise.all([
            vscode.window.showInformationMessage(`Deleted cluster ${clusterName}`),
            kindCloudProvider.refresh()
        ]);
    } else {
        await vscode.window.showErrorMessage(`Deleting Kind cluster failed: ${result.error[0]}`);
    }
}

async function promptCluster(progressMessage: string): Promise<string | undefined> {
    const clusters = await longRunning(progressMessage, () => kind.getClusters(shell));
    if (failed(clusters)) {
        return await vscode.window.showInputBox({ prompt: 'Cluster to delete'});
    } else {
        return await vscode.window.showQuickPick(clusters.result.map((c) => c.name));
    }
}

async function tryResolveClusterNode(target: any): Promise<KindCloudProviderClusterNode | undefined> {
    const cloudExplorer = await k8s.extension.cloudExplorer.v1;
    if (!cloudExplorer.available) {
        return undefined;
    }
    const cloudExplorerNode = cloudExplorer.api.resolveCommandTarget(target);
    if (cloudExplorerNode && cloudExplorerNode.nodeType === 'resource' && cloudExplorerNode.cloudName === 'Kind') {
        const kindTreeNode: KindCloudProviderTreeNode = cloudExplorerNode.cloudResource;
        if (kindTreeNode.nodeType === 'cluster') {
            return kindTreeNode;
        }
    }
    return undefined;
}
