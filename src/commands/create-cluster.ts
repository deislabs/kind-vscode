import * as vscode from 'vscode';
import { map, filter } from 'rxjs/operators';

import * as kind from '../kind/kind';
import { safeFilePath } from '../utils/uri';
import { withTempFile } from '../utils/tempfile';
import { shell, ProcessTrackingEvent } from '../utils/shell';
import { succeeded, Errorable } from '../utils/errorable';
import { longRunningWithMessages, ProgressStep, ProgressUpdate } from '../utils/host';
import { Cancellable } from '../utils/cancellable';
import { showHTMLForm } from '../utils/webview';
import { cantHappen } from '../utils/never';
import { Observable } from 'rxjs';

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

    const progressSteps = kind.createCluster(shell, settings.value.name, settings.value.image).pipe(
        map((e) => progressOf(e))
    );

    await displayClusterCreationUI(progressSteps);
}

async function createClusterFromSpec(document: ClusterSpecDocument): Promise<void> {
    const progressSteps = await withClusterSpec(document, (filename) =>
        kind.createClusterFromConfigFile(shell, filename).pipe(
            map((e) => progressOf(e))
        )
    );

    await displayClusterCreationUI(progressSteps);
}

async function displayClusterCreationUI(progressSteps: Observable<ProgressStep<Errorable<null>>>): Promise<void> {
    const progressToDisplay = undecorateClusterCreationOutput(progressSteps);
    const result = await longRunningWithMessages("Creating Kind cluster", progressToDisplay);
    await displayClusterCreationResult(result);
}

function progressOf(e: ProcessTrackingEvent): ProgressStep<Errorable<null>> {
    if (e.eventType === 'line') {
        return { type: 'update', message: e.text };
    } else if (e.eventType === 'succeeded') {
        return { type: 'complete', value: { succeeded: true, result: null } };
    } else if (e.eventType === 'failed') {
        return { type: 'complete', value: { succeeded: false, error: [e.stderr] } };
    } else {
        return cantHappen(e);
    }
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

async function withClusterSpec<T>(document: ClusterSpecDocument, fn: (filename: string) => T): Promise<T> {
    if (document.dirty || !document.path) {
        return await withTempFile<T>(document.text, 'yaml', fn);
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

function undecorateClusterCreationOutput<T>(events: Observable<ProgressStep<T>>): Observable<ProgressStep<T>> {
    const interestingUpdatePrefix = '• ';
    const stripPrefix = (e: ProgressUpdate) => ({ type: 'update' as const, message: e.message.substring(interestingUpdatePrefix.length) } as ProgressUpdate);
    const isIgnorableUpdate = (e: ProgressStep<T>) => e.type === 'update' && !e.message.startsWith(interestingUpdatePrefix);
    const undecorate = (e: ProgressStep<T>) => e.type === 'update' ? stripPrefix(e) : e;
    return events.pipe(
        filter((e) => !isIgnorableUpdate(e)),
        map((e) => undecorate(e))
    );
}
