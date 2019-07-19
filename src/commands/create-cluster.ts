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
    // Config documents aren't self-contained: you still need to prompt for the name
    // and image.  So when should we take a config document into account?
    // The current solution is:
    // 1. If the command was launched from Cloud Explorer, *DO NOT* use a config document.
    //    The user isn't looking at the document so we shouldn't apply it.
    // 2. If the command was launched from the Command Palette, and the active document
    //    is a config document, *USE IT*.  The user has probably been working in the
    //    editor and wants to go with the settings they've been working on.
    // 3. Otherwise, don't use a config document, because it's not obvious which if any
    //    document to use.
    // Does this seem reasonable?  Is there a better strategy?

    const clusterSpec = activeDocumentAsClusterSpec();  // Capture this here, because we're about to display an interactive prompt which will make the current document inactive

    const settings = await promptClusterSettings();
    if (settings.cancelled) {
        return;
    }

    if (target) {
        await createClusterInteractive(settings.value);
        return;
    }

    if (clusterSpec) {
        await createClusterFromSpec(clusterSpec, settings.value);
        return;
    }

    await createClusterInteractive(settings.value);
}

async function createClusterInteractive(settings: InteractiveClusterSettings): Promise<void> {
    const progressSteps = kind.createCluster(shell, settings.name, settings.image, undefined).pipe(
        map((e) => progressOf(e))
    );

    await displayClusterCreationUI(progressSteps);
}

async function createClusterFromSpec(document: ClusterSpecDocument, settings: InteractiveClusterSettings): Promise<void> {
    const progressSteps = await withClusterSpec(document, (filename) =>
        kind.createCluster(shell, settings.name, settings.image, filename).pipe(
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

// Settings that are gathered interactively (because they can't be set in the config file)
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
