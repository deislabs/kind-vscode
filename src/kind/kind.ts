import * as vscode from 'vscode';

// import * as config from '../config/config';
import { Errorable } from '../utils/errorable';
import * as shell from '../utils/shell';
import { KindClusterInfo } from "./kind.objectmodel";
import { Observable } from 'rxjs';

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
            .map((l) => ({ name: l }));
    }
    return invokeObj(sh, 'get clusters', '', {}, parse);
}

export async function getKubeconfig(sh: shell.Shell, clusterName: string): Promise<Errorable<string>> {
    return invokeObj(sh, `get kubeconfig`, `--name ${clusterName}`, {}, (s) => s);
}

export function createCluster(sh: shell.Shell, clusterName: string, image?: string): Observable<shell.ProcessTrackingEvent> {
    const imageArgs = image ? ['--image', image] : [];
    return invokeTracking(sh, 'create cluster', '--name', clusterName, ...imageArgs);
}

export function createClusterFromConfigFile(sh: shell.Shell, configFilePath: string): Observable<shell.ProcessTrackingEvent> {
    return invokeTracking(sh, 'create cluster', '--config', configFilePath);
}
