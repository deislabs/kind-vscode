import * as vscode from 'vscode';

import * as kind from '../kind/kind';
import { safeFilePath } from '../utils/uri';
import { withTempFile } from '../utils/tempfile';
import { shell } from '../utils/shell';
import { succeeded, Errorable } from '../utils/errorable';
import { longRunning } from '../utils/host';
import { Cancellable } from '../utils/cancellable';
import { showHTMLForm } from '../utils/webview';

export async function onCreateCluster(target?: any): Promise<void> {
    if (target) {
        await createClusterInteractive();
        return;
    }

    const clusterSpec = activeDocumentAsClusterSpec();
    if (clusterSpec) {
        await createClusterFromSpec(clusterSpec);
        return;
    }

    await createClusterInteractive();
}

async function createClusterInteractive(): Promise<void> {
    const settings = await promptClusterSettings();
    if (settings.cancelled) {
        return;
    }
    const result = await longRunning("Creating Kind cluster...", () =>
        kind.createCluster(shell, settings.value.name, settings.value.image)
    );
    await displayClusterCreationResult(result);
}

async function createClusterFromSpec(document: ClusterSpecDocument): Promise<void> {
    const result = await longRunning("Creating Kind cluster...", () =>
        withClusterSpec(document, (filename) =>
            kind.createClusterFromConfigFile(shell, filename)
        )
    );
    await displayClusterCreationResult(result);
}

async function displayClusterCreationResult(result: Errorable<null>): Promise<void> {
    if (succeeded(result)) {
        // TODO: refresh cloud explorer, option to kick off merging kubeconfig (which should in turn refresh cluster explorer)
        await vscode.window.showInformationMessage("Created Kind cluster");
    } else {
        await vscode.window.showErrorMessage(`Creating Kind cluster failed: ${result.error[0]}`);
    }
}

function activeDocumentAsClusterSpec(): ClusterSpecDocument | undefined {
    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
        return undefined;
    }

    const activeDocument = activeEditor.document;
    const activeDocumentText = activeDocument.getText();

    if (isYAML(activeDocument) && isKindClusterSpec(activeDocumentText)) {
        return {
            text: activeDocumentText,
            dirty: activeDocument.isDirty,
            path: safeFilePath(activeDocument.uri),
        };
    }

    return undefined;
}

function withClusterSpec<T>(document: ClusterSpecDocument, fn: (filename: string) => Promise<T>): Promise<T> {
    if (document.dirty || !document.path) {
        return withTempFile<T>(document.text, 'yaml', fn);
    }
    return fn(document.path);
}

function isYAML(document: vscode.TextDocument): boolean {
    return document.languageId === 'yaml';
}

function isKindClusterSpec(yamlText: string): boolean {
    // This is a bit crude but it's probably good enough for our purposes
    return yamlText.includes('kind: Cluster') &&
        yamlText.includes('apiVersion: kind.sigs.k8s.io');
}

const NAME_FIELD_NAME = 'clustername';
const IMAGE_FIELD_NAME = 'clusterimage';

async function promptClusterSettings(): Promise<Cancellable<InteractiveClusterSettings>> {
    // TODO: moar sharing with the cluster provider
    // TODO: call Docker Hub for available versions, or use a freeform 'image' field to allow custom images
    // TODO: validation!  (Which might not play nicely with the single-async-return model.)
    const formHTML = `
        <p>Cluster name: <input type='text' name='${NAME_FIELD_NAME}' value='kind' /></p>
        <p>Image version (blank for default): <input type='text' name='${IMAGE_FIELD_NAME}' value='' /></p>
    `;

    const formResult = await showHTMLForm("kind.createCluster", "Create Kind Cluster", formHTML, "Create Cluster");
    if (formResult.cancelled) {
        return formResult;
    }

    const name = formResult.value[NAME_FIELD_NAME];
    const image = formResult.value[IMAGE_FIELD_NAME].length > 0 ? formResult.value[IMAGE_FIELD_NAME] : undefined;

    return {
        cancelled: false,
        value: { name, image }
    };
}

interface ClusterSpecDocument {
    readonly text: string;
    readonly dirty: boolean;
    readonly path: string | undefined;
}

interface InteractiveClusterSettings {
    readonly name: string;
    readonly image: string | undefined;
}
