import * as vscode from 'vscode';

// import * as config from '../config/config';
import { Errorable } from '../utils/errorable';
import * as shell from '../utils/shell';
import { KindClusterInfo } from "./kind.objectmodel";
import { Observable } from 'rxjs';
import '../utils/array';

const logChannel = vscode.window.createOutputChannel("Kind");

async function invokeObj<T>(sh: shell.Shell, command: string, args: string, opts: shell.ExecOpts, fn: (stdout: string) => T): Promise<Errorable<T>> {
    const bin = /* config.kindPath() || */ 'kind';
    const cmd = `${bin} ${command} ${args}`;
    logChannel.appendLine(`$ ${cmd}`);
    return await sh.execObj<T>(
        cmd,
        `kind ${command}`,
        opts,
        andLog(fn)
    );
}

function andLog<T>(fn: (s: string) => T): (s: string) => T {
    return (s: string) => {
        logChannel.appendLine(s);
        return fn(s);
    };
}

function invokeTracking(sh: shell.Shell, command: string, ...args: string[]): Observable<shell.ProcessTrackingEvent> {
    const bin = /* config.kindPath() || */ 'kind';
    const cmd = [...(command.split(' ')), ...args];
    logChannel.appendLine(`$ ${bin} ${cmd.join(' ')}`);
    return sh.execTracking(bin, cmd);
}

export async function getClusters(sh: shell.Shell): Promise<Errorable<KindClusterInfo[]>> {
    function parse(stdout: string): KindClusterInfo[] {
        return stdout.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0)
            .map((l) => ({ name: l }))
            .orderBy((c) => c.name);  // Possibly this shouldn't be mixed up with the raw CLI module but I can't think of a time when we'd want the internal order
    }
    return invokeObj(sh, 'get clusters', '', {}, parse);
}

export async function getKubeconfig(sh: shell.Shell, clusterName: string): Promise<Errorable<string>> {
    return invokeObj(sh, `get kubeconfig`, `--name ${clusterName}`, {}, (s) => s);
}

export function createCluster(sh: shell.Shell, clusterName: string, image: string | undefined, configFilePath: string | undefined): Observable<shell.ProcessTrackingEvent> {
    const imageArgs = image ? ['--image', image] : [];
    const configFileArgs = configFilePath ? ['--config', configFilePath] : [];
    return invokeTracking(sh, 'create cluster', '--name', clusterName, ...imageArgs, ...configFileArgs);
}

export function deleteCluster(sh: shell.Shell, clusterName: string): Promise<Errorable<null>> {
    return invokeObj(sh, 'delete cluster', `--name ${clusterName}`, {}, (_) => null);
}

export async function version(sh: shell.Shell): Promise<Errorable<string>> {
    return invokeObj(sh, `version`, '', {}, (s) => s.trim());
}
