import * as vscode from 'vscode';
import mdns = require('multicast-dns');

export interface MdnsService {
    address: string;
    fqdn: string;
    name: string;
    port: number;
    text: string[];
}

export interface MdnsClient {
    readonly onServiceDown: vscode.Event<MdnsService>;
    readonly onServiceUp: vscode.Event<MdnsService>;

    start(type: string): Promise<void>;
    stop(): Promise<void>;
}

function isAddressAnswer(answer: mdns.MdnsAnswer): answer is mdns.MdnsAddressAnswer {
    return answer.type === 'A';
}

function isPointerAnswer(answer: mdns.MdnsAnswer): answer is mdns.MdnsPointerAnswer {
    return answer.type === 'PTR';
}

function isServerAnswer(answer: mdns.MdnsAnswer): answer is mdns.MdnsServerAnswer {
    return answer.type === 'SRV';
}

function isTextAnswer(answer: mdns.MdnsAnswer): answer is mdns.MdnsTextAnswer {
    return answer.type === 'TXT';
}

export default class MulticastDnsMdnsClient extends vscode.Disposable implements MdnsClient {
    private readonly serviceUpEmitter = new vscode.EventEmitter<MdnsService>();
    private readonly serviceDownEmitter = new vscode.EventEmitter<MdnsService>();
    private readonly instance = mdns();
    private type: string | undefined;
    private knownServices: { [key: string]: MdnsService } = {};

    constructor() {
        super(() => {
            this.serviceUpEmitter.dispose();
            this.serviceDownEmitter.dispose();
            this.instance.destroy();
        });

        // eslint-disable-next-line @typescript-eslint/unbound-method
        this.onResponse = this.onResponse.bind(this);
    }

    get onServiceDown(): vscode.Event<MdnsService> {
        return this.serviceDownEmitter.event;
    }

    get onServiceUp(): vscode.Event<MdnsService> {
        return this.serviceUpEmitter.event;
    }

    async start(type: string): Promise<void> {
        await this.stop();

        this.type = type;

        // eslint-disable-next-line @typescript-eslint/unbound-method
        this.instance.on('response', this.onResponse);

        await this.query(type);
    }

    stop(): Promise<void> {
        // eslint-disable-next-line @typescript-eslint/unbound-method
        this.instance.removeListener('response', this.onResponse);

        this.knownServices = {};

        return Promise.resolve();
    }

    private query(type: string): Promise<void> {
        return new Promise(
            (resolve, reject) => {
                this.instance.query(
                    {
                        questions: [
                            {
                                name: type,
                                type: 'PTR'
                            }
                        ]
                    },
                    (err: Error | undefined) => {
                        if (err) {
                            return reject(err);
                        } else {
                            return resolve();
                        }
                    });
            });
    }

    private onResponse(packet: mdns.MdnsPacket): void {
        const upServices: MdnsService[] = [];
        const downServices: string[] = [];

        packet
            .answers
            .filter(answer => answer.name === this.type)
            .filter(isPointerAnswer)
            .forEach(answer => {
                const name = answer.data;

                if (answer.ttl) {
                    upServices.push({ address: '', fqdn: '', name, port: 0, text: [] });
                } else {
                    downServices.push(name);
                }
            });

        upServices.forEach(service => {
            packet
                .answers
                .filter(answer => answer.name === service.name)
                .filter(isServerAnswer)
                .forEach(answer => {
                    service.fqdn = answer.data.target;
                    service.port = answer.data.port;
                });

            packet
                .answers
                .filter(answer => answer.name === service.name)
                .filter(isTextAnswer)
                .forEach(answer => {
                    service.text = answer.data.map(buffer => buffer.toString());
                });

            packet
                .answers
                .filter(answer => answer.name === service.fqdn)
                .filter(isAddressAnswer)
                .forEach(answer => {
                    service.address = answer.data;
                });

            // TODO: Are we sure fqdn assures the others are populated?
            if (service.fqdn && !this.knownServices[service.name]) {
                this.knownServices[service.name] = service;

                this.serviceUpEmitter.fire(service);
            }
        });

        downServices.forEach(name => {
            const service = this.knownServices[name];
            
            if (service) {
                delete this.knownServices[name];

                this.serviceDownEmitter.fire(service);
            }
        });
    }
}
