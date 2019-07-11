import * as vscode from 'vscode';

// import * as config from '../config/config';
import { Errorable } from '../utils/errorable';
import * as shell from '../utils/shell';
import { KindClusterInfo } from "./kind.objectmodel";

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
