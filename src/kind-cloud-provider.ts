import * as k8s from 'vscode-kubernetes-tools-api';
import * as vscode from 'vscode';
import { shell } from './utils/shell';
import { failed, succeeded } from './utils/errorable';
import './utils/string';

class KindCloudProvider implements k8s.CloudExplorerV1.CloudProvider {
    readonly cloudName = "Kind";
    readonly treeDataProvider = new KindTreeDataProvider();
    async getKubeconfigYaml(cluster: any): Promise<string | undefined> {
        const treeNode = cluster as KindCloudProviderTreeNode;
        if (treeNode.nodeType === 'cluster') {
            return await getKindKubeconfigYaml(treeNode.clusterName);
        }
        return undefined;
    }
}

interface KindCloudProviderClusterNode {
    readonly nodeType: 'cluster';
    readonly clusterName: string;
}

interface KindCloudProviderErrorNode {
    readonly nodeType: 'error';
    readonly diagnostic: string;
}

type KindCloudProviderTreeNode = KindCloudProviderClusterNode | KindCloudProviderErrorNode;

class KindTreeDataProvider implements vscode.TreeDataProvider<KindCloudProviderTreeNode> {
    private onDidChangeTreeDataEmitter: vscode.EventEmitter<KindCloudProviderTreeNode | undefined> = new vscode.EventEmitter<KindCloudProviderTreeNode | undefined>();
    readonly onDidChangeTreeData: vscode.Event<KindCloudProviderTreeNode | undefined> = this.onDidChangeTreeDataEmitter.event;

    getTreeItem(element: KindCloudProviderTreeNode): vscode.TreeItem | Thenable<vscode.TreeItem> {
        if (element.nodeType === 'error') {
            const treeItem = new vscode.TreeItem("Error", vscode.TreeItemCollapsibleState.None);
            treeItem.tooltip = element.diagnostic;
            return treeItem;
        } else {
            const treeItem = new vscode.TreeItem(element.clusterName, vscode.TreeItemCollapsibleState.None);
            treeItem.contextValue = k8s.CloudExplorerV1.SHOW_KUBECONFIG_COMMANDS_CONTEXT;
            return treeItem;
        }
    }
    getChildren(element?: KindCloudProviderTreeNode | undefined): vscode.ProviderResult<KindCloudProviderTreeNode[]> {
        if (element) {
            return [];
        }
        return getClusters();
    }
}

async function getClusters(): Promise<KindCloudProviderTreeNode[]> {
    const sr = await shell.exec('kind get clusters');
    if (failed(sr) || sr.result.code !== 0) {
        return [{ nodeType: 'error', diagnostic: succeeded(sr) ? sr.result.stderr : sr.error[0] }];
    }
    const lines = sr.result.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
    return lines.map((l) => ({ nodeType: 'cluster', clusterName: l }));
}

async function getKindKubeconfigYaml(clusterName: string): Promise<string | undefined> {
    const sr = await shell.exec(`kind get kubeconfig --name ${clusterName}`);
    if (succeeded(sr) && sr.result.code === 0) {
        const originalKubeconfig = sr.result.stdout;
        const distinctKubeconfig = renameDistinctUser(originalKubeconfig, clusterName);
        return distinctKubeconfig;
    }
    vscode.window.showErrorMessage(`Can't get kubeconfig for ${clusterName}: ${succeeded(sr) ? sr.result.stderr : sr.error[0]}`);
    return undefined;
}

function renameDistinctUser(kubeconfig: string, clusterName: string): string {
    // kubeconfig is YAML of the following form.  Kind names the user kubernetes-admin
    // by default, which of course causes clashes if you try to merge multiple Kind
    // kubeconfigs.  So the plan is to rename the user to be distinct.
    //
    // apiVersion: ...
    // clusters:
    // - ...
    // contexts:
    // - context:
    //     cluster: ...
    //     user: kubernetes-admin  # mentions non-distinct name
    //   name: kubernetes-admin@<clustername>  # mentions non-distinct name (and is annoying name)
    // current-context: ...
    // kind: Config
    // preferences: {}
    // users:
    // - name: kubernetes-admin  # defines non-distinct name
    //   user:
    //     client-certificate-data: ...
    //     client-key-data: ...

    return kubeconfig.replaceAll(`kubernetes-admin@${clusterName}`, clusterName)
                     .replaceAll('kubernetes-admin', `kubernetes-admin-${clusterName}`);
}

export const KIND_CLOUD_PROVIDER = new KindCloudProvider();
