import * as vscode from 'vscode';
import { map, filter } from 'rxjs/operators';

import * as kind from '../kind/kind';
import * as kindCloudProvider from '../kind-cloud-provider';
import { safeFilePath } from '../utils/uri';
import { withTempFile } from '../utils/tempfile';
import { shell, ProcessTrackingEvent } from '../utils/shell';
import { succeeded, Errorable, failed } from '../utils/errorable';
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
        await Promise.all([
            vscode.window.showInformationMessage("Created Kind cluster"),
            kindCloudProvider.refresh()
        ]);
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
const STANDARD_IMAGE_FIELD_NAME = 'clusterimage_standard';
const CUSTOM_IMAGE_FIELD_NAME = 'clusterimage_custom';

async function promptClusterSettings(): Promise<Cancellable<InteractiveClusterSettings>> {
    // TODO: moar sharing with the cluster provider
    // TODO: validation!  (Which might not play nicely with the single-async-return model.)
    const standardImageOptions = (await standardImages()).map((image) => `<option value='${image.id}'>${image.name}</option>`)
                                                         .join('\n');
    const formHTML = `
        <p>Cluster name: <input type='text' name='${NAME_FIELD_NAME}' value='kind' /></p>
        <p>Node image version (custom image takes precedence if specified)</p>
        <p>- Standard image: <select name='${STANDARD_IMAGE_FIELD_NAME}'>${standardImageOptions}</select></p>
        <p>- Custom image: <input type='text' name='${CUSTOM_IMAGE_FIELD_NAME}' value='' /></p>
    `;

    const formResult = await showHTMLForm("kind.createCluster", "Create Kind Cluster", formHTML, "Create Cluster");
    if (formResult.cancelled) {
        return formResult;
    }

    const name = formResult.value[NAME_FIELD_NAME];
    const standardImage = formResult.value[STANDARD_IMAGE_FIELD_NAME];
    const customImage = formResult.value[CUSTOM_IMAGE_FIELD_NAME];
    // TODO: okay for custom to take priority?
    const image = (customImage && customImage.length > 0) ? customImage : ((standardImage.length > 0) ? standardImage : undefined);

    return {
        cancelled: false,
        value: { name, image }
    };
}

async function standardImages(): Promise<StandardImage[]> {
    const defaultImage = { name: 'Use the default image', id: ''};  // always have a blank for default
    const versionText = await kind.version(shell);
    if (failed(versionText)) {
        return [defaultImage];
    }
    const version = trimToVersion(versionText.result);
    const standardImages = standardImagesForVersion(version);
    return [defaultImage].concat(...standardImages);
}

function trimToVersion(versionText: string): string {
    if (versionText.startsWith('kind ')) {
        return versionText.substring('kind '.length);
    }
    return versionText;
}

function standardImagesForVersion(version: string): StandardImage[] {
    return standardImageIdsForVersion(version).map(imageify);
}

function standardImageIdsForVersion(version: string): string[] {
    if (version.startsWith('v0.1') || version.startsWith('v0.2')) {
        return [];
    } else if (version.startsWith('v0.3')) {
        return [
            'kindest/nodev1.14.2@sha256:33539d830a6cf20e3e0a75d0c46a4e94730d78c7375435e6b49833d81448c319',
            'kindest/node:v1.13.6@sha256:9e07014fb48c746deb98ec8aafd58c3918622eca6063e643c6e6d86c86e170b4',
            'kindest/node:v1.12.8@sha256:cc6e1a928a85c14b52e32ea97a198393fb68097f14c4d4c454a8a3bc1d8d486c',
            'kindest/node:v1.11.10@sha256:abd0275ead5ddfd477b7bc491f71957d7dd75408a346834ffe8a9bee5fbdc15b',
        ];
    } else if (version.startsWith('v0.4')) {
        return [
            'kindest/node:v1.15.0@sha256:b4d092fd2b507843dd096fe6c85d06a27a0cbd740a0b32a880fe61aba24bb478',
            'kindest/node:v1.14.3@sha256:583166c121482848cd6509fbac525dd62d503c52a84ff45c338ee7e8b5cfe114',
            'kindest/node:v1.13.7@sha256:f3f1cfc2318d1eb88d91253a9c5fa45f6e9121b6b1e65aea6c7ef59f1549aaaf',
            'kindest/node:v1.12.9@sha256:bcb79eb3cd6550c1ba9584ce57c832dcd6e442913678d2785307a7ad9addc029',
            'kindest/node:v1.11.10@sha256:176845d919899daef63d0dbd1cf62f79902c38b8d2a86e5fa041e491ab795d33',
        ];
    } else if (version.startsWith('v0.5')) {
        return [
            'kindest/node:v1.15.3@sha256:27e388752544890482a86b90d8ac50fcfa63a2e8656a96ec5337b902ec8e5157',
            'kindest/node:v1.14.6@sha256:464a43f5cf6ad442f100b0ca881a3acae37af069d5f96849c1d06ced2870888d',
            'kindest/node:v1.13.10@sha256:2f5f882a6d0527a2284d29042f3a6a07402e1699d792d0d5a9b9a48ef155fa2a',
            'kindest/node:v1.12.10@sha256:e43003c6714cc5a9ba7cf1137df3a3b52ada5c3f2c77f8c94a4d73c82b64f6f3',
            'kindest/node:v1.11.10@sha256:bb22258625199ba5e47fb17a8a8a7601e536cd03456b42c1ee32672302b1f909',
        ];
    } else if (version.startsWith('v0.6')) {
        return [
            'kindest/node:v1.16.3@sha256:70ce6ce09bee5c34ab14aec2b84d6edb260473a60638b1b095470a3a0f95ebec',
            'kindest/node:v1.15.6@sha256:18c4ab6b61c991c249d29df778e651f443ac4bcd4e6bdd37e0c83c0d33eaae78',
            'kindest/node:v1.14.9@sha256:bdd3731588fa3ce8f66c7c22f25351362428964b6bca13048659f68b9e665b72',
            'kindest/node:v1.13.12@sha256:1fe072c080ee129a2a440956a65925ab3bbd1227cf154e2ade145b8e59a584ad',
            'kindest/node:v1.12.10@sha256:c5aeca1433e3230e6c1a96b5e1cd79c90139fd80242189b370a3248a05d77118',
            'kindest/node:v1.11.10@sha256:8ebe805201da0a988ee9bbcc2de2ac0031f9264ac24cf2a598774f1e7b324fe1',
        ];
    } else if (version.startsWith('v0.7')) {
        return [
            'kindest/node:v1.18.0@sha256:0e20578828edd939d25eb98496a685c76c98d54084932f76069f886ec315d694',
            'kindest/node:v1.17.0@sha256:9512edae126da271b66b990b6fff768fbb7cd786c7d39e86bdf55906352fdf62',
            'kindest/node:v1.16.4@sha256:b91a2c2317a000f3a783489dfb755064177dbc3a0b2f4147d50f04825d016f55',
            'kindest/node:v1.15.7@sha256:e2df133f80ef633c53c0200114fce2ed5e1f6947477dbc83261a6a921169488d',
            'kindest/node:v1.14.10@sha256:81ae5a3237c779efc4dda43cc81c696f88a194abcc4f8fa34f86cf674aa14977',
            'kindest/node:v1.13.12@sha256:5e8ae1a4e39f3d151d420ef912e18368745a2ede6d20ea87506920cd947a7e3a',
            'kindest/node:v1.12.10@sha256:68a6581f64b54994b824708286fafc37f1227b7b54cbb8865182ce1e036ed1cc',
            'kindest/node:v1.11.10@sha256:e6f3dade95b7cb74081c5b9f3291aaaa6026a90a977e0b990778b6adc9ea6248',
        ];
    } else {
        return vscode.workspace.getConfiguration().get('kind-unknown-version-image-versions') || [];
    }
}

function imageify(imageId: string): StandardImage {
    const bits = imageId.split('@');
    return { name: bits[0], id: imageId };
}

interface StandardImage {
    readonly name: string;
    readonly id: string;
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
