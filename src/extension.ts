import * as k8s from 'vscode-kubernetes-tools-api';
import * as vscode from 'vscode';
import { KIND_CLUSTER_PROVIDER } from './kind-cluster-provider';
import { KIND_CLOUD_PROVIDER } from './kind-cloud-provider';

export async function activate(context: vscode.ExtensionContext) {
    const clusterProvider = await k8s.extension.clusterProvider.v1;
    if (clusterProvider.available) {
        clusterProvider.api.register(KIND_CLUSTER_PROVIDER);
    } else {
        vscode.window.showErrorMessage("Can't register Kind cluster provider: " + clusterProvider.reason);
    }

    const cloudExplorer = await k8s.extension.cloudExplorer.v1;
    if (cloudExplorer.available) {
        cloudExplorer.api.registerCloudProvider(KIND_CLOUD_PROVIDER);
    } else {
        vscode.window.showErrorMessage("Can't register Kind cloud provider: " + cloudExplorer.reason);
    }

    const disposables = [
        vscode.commands.registerCommand("kind.createCluster", onCreateCluster),
    ];

    context.subscriptions.push(...disposables);
}

function onCreateCluster(target?: any) {
    // if target is the Cloud Explorer root node:
    //   go to wizard
    // else if the active document is a Kind cluster spec:
    //   create from the spec
    // else
    //   go to the wizard
    vscode.window.showInformationMessage(`Hello ${target}`);
}
