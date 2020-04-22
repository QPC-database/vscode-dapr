// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import Timer from '../util/timer';
import { ProcessProvider } from './processProvider';
import { MdnsClient, MdnsProvider, MdnsService } from './mdnsProvider';

export interface DaprApplication {
    appId: string;
    httpPort: number;
    pid?: number;
}

export interface DaprApplicationProvider {
    readonly onDidChange: vscode.Event<void>;

    getApplications(): Promise<DaprApplication[]>;
}

function getAppId(cmd: string): string | undefined {
    const appIdRegEx = /--app-id "?(?<appId>[a-zA-Z0-9_-]+)"?/g;
        
    const appIdMatch = appIdRegEx.exec(cmd);
    
    return appIdMatch?.groups?.['appId'];
}

function getHttpPort(cmd: string): number {
    const portRegEx = /--dapr-http-port "?(?<port>\d+)"?/g;
        
    const portMatch = portRegEx.exec(cmd);
    
    const portString = portMatch?.groups?.['port'];
    
    if (portString !== undefined) {
        return parseInt(portString, 10);
    } else {
        return 3500;
    }
}

function toApplication(cmd: string | undefined, pid: number): DaprApplication | undefined {
    if (cmd) {
        const appId = getAppId(cmd);

        if (appId) {
            return {
                appId,
                httpPort: getHttpPort(cmd),
                pid
            };
        }
    }

    return undefined;
}

export class MdnsBasedDaprApplicationProvider extends vscode.Disposable implements DaprApplicationProvider {
    private applications: DaprApplication[] = [];
    private downListener: vscode.Disposable | undefined;
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    private mdnsClient: MdnsClient | undefined;
    private upListener: vscode.Disposable | undefined;

    constructor(private readonly mdnsProvider: MdnsProvider) {
        super(() => {
            this.downListener?.dispose();
            this.upListener?.dispose();

            this.mdnsClient?.dispose();

            this.onDidChangeEmitter.dispose();
        });
    }
    
    get onDidChange(): vscode.Event<void> {
        return this.onDidChangeEmitter.event;
    }

    async getApplications(): Promise<DaprApplication[]> {
        if (!this.mdnsClient) {
            this.mdnsClient = this.mdnsProvider.createClient('_dapr._tcp.local');
            
            this.downListener = this.mdnsClient.onServiceDown(
                service => {
                    const application = MdnsBasedDaprApplicationProvider.toApplication(service);

                    if (application) {
                        const index = this.applications.findIndex(a => a.appId === application.appId);
                        
                        if (index !== -1) {
                            this.applications.splice(index);

                            this.onDidChangeEmitter.fire();
                        }
                    }

                    this.onDidChangeEmitter.fire();
                });

            this.upListener = this.mdnsClient.onServiceUp(
                service => {
                    const application = MdnsBasedDaprApplicationProvider.toApplication(service);

                    if (application) {
                        const index = this.applications.findIndex(a => a.appId === application.appId);
                        
                        if (index !== -1) {
                            this.applications[index] = application;
                        } else {
                            this.applications.push(application);
                        }

                        this.onDidChangeEmitter.fire();
                    }
                });

            await this.mdnsClient.start();
        }

        return Promise.resolve(this.applications);
    }

    private static toApplication(service: MdnsService): DaprApplication | undefined {
        const parsedText = service.text.map(t => t.split('=')).filter(t => t.length === 2);

        const appId = parsedText.find(t => t[0] === 'appId')?.[1];
        const httpPort = parsedText.find(t => t[0] === 'httpPort')?.[1];
        
        if (appId && httpPort) {
            return {
                appId,
                httpPort: parseInt(httpPort, 10)
            };
        } else {
            return undefined;
        }
    }
}

export default class ProcessBasedDaprApplicationProvider extends vscode.Disposable implements DaprApplicationProvider {
    private applications: DaprApplication[] | undefined;
    private currentRefresh: Promise<void> | undefined;
    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    private readonly timer: vscode.Disposable;

    constructor(private readonly processProvider: ProcessProvider) {
        super(() => {
            this.timer.dispose();
            this.onDidChangeEmitter.dispose();
        });

        // TODO: Do a sane comparison of the old vs. new applications.
        this.timer = Timer.Interval(
            2000,
            () => {
                this.refreshApplications();
            });
    }

    get onDidChange(): vscode.Event<void> {
        return this.onDidChangeEmitter.event;
    }

    async getApplications(refresh?: boolean): Promise<DaprApplication[]> {
        if (!this.applications || refresh) {
            await this.refreshApplications();
        }

        return this.applications ?? [];
    }

    private async refreshApplications(): Promise<void> {
        if (!this.currentRefresh) {
            this.currentRefresh = this.onRefresh();
        }

        await this.currentRefresh;

        this.currentRefresh = undefined;
    }

    private async onRefresh(): Promise<void> {
        const processes = await this.processProvider.listProcesses('daprd');
        
        this.applications = processes
            .map(process => toApplication(process.cmd, process.pid))
            .filter((application): application is DaprApplication => application !== undefined);
        
        this.onDidChangeEmitter.fire();
    }
}
