'use strict';

import * as shelljs from 'shelljs';
import * as vscode from 'vscode';

import { Errorable } from './errorable';

export interface ExecOpts {
    readonly cwd?: string;
}

export interface Shell {
    exec(cmd: string, stdin?: string): Promise<Errorable<ShellResult>>;
    execObj<T>(cmd: string, cmdDesc: string, opts: ExecOpts, fn: (stdout: string) => T): Promise<Errorable<T>>;
}

export const shell: Shell = {
    exec: exec,
    execObj: execObj,
};

export interface ShellResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

export type ShellHandler = (code: number, stdout: string, stderr: string) => void;

function execOpts(): any {
    const env = process.env;
    const opts = {
        cwd: vscode.workspace.rootPath,
        env: env,
        async: true
    };
    return opts;
}

async function exec(cmd: string, stdin?: string): Promise<Errorable<ShellResult>> {
    try {
        return { succeeded: true, result: await execCore(cmd, execOpts(), stdin) };
    } catch (ex) {
        return { succeeded: false, error: [`Error invoking '${cmd}: ${ex}`] };
    }
}

async function execObj<T>(cmd: string, cmdDesc: string, opts: ExecOpts, fn: ((stdout: string) => T)): Promise<Errorable<T>> {
    const o = Object.assign({}, execOpts(), opts);
    try {
        const sr = await execCore(cmd, o);
        if (sr.code === 0) {
            const value = fn(sr.stdout);
            return { succeeded: true, result: value };
        } else {
            return { succeeded: false, error: [`${cmdDesc} error: ${sr.stderr}`] };
        }
    } catch (ex) {
        return { succeeded: false, error: [`Error invoking '${cmd}: ${ex}`] };
    }
}

function execCore(cmd: string, opts: any, stdin?: string): Promise<ShellResult> {
    return new Promise<ShellResult>((resolve, _reject) => {
        const proc = shelljs.exec(cmd, opts, (code, stdout, stderr) => resolve({ code: code, stdout: stdout, stderr: stderr }));
        if (stdin) {
            proc.stdin.end(stdin);
        }
    });
}
