// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as elementtree from "elementtree";
import * as fs from "fs";
import * as messaging from "./common/extensionMessaging";
import * as path from "path";
import * as Q from "q";

import {DebugProtocol} from "vscode-debugprotocol";
import {IAttachRequestArgs, ICommonRequestArgs} from "vscode-chrome-debug-core";
import {execCommand} from "./debugger/extension";

const ANDROID_MANIFEST_PATH = path.join("platforms", "android", "AndroidManifest.xml");
const ANDROID_MANIFEST_PATH_8 = path.join("platforms", "android", "app", "src", "main", "AndroidManifest.xml");

export interface ICordovaAttachRequestArgs extends DebugProtocol.AttachRequestArguments, IAttachRequestArgs {
    cwd: string; /* Automatically set by VS Code to the currently opened folder */
    platform: string;
    target?: string;
    webkitRangeMin?: number;
    webkitRangeMax?: number;
    attachAttempts?: number;
    attachDelay?: number;
    attachTimeout?: number;
    simulatorInExternalBrowser?: boolean;

    // Ionic livereload properties
    ionicLiveReload?: boolean;
}

export interface ICordovaLaunchRequestArgs extends DebugProtocol.LaunchRequestArguments, ICordovaAttachRequestArgs {
    iosDebugProxyPort?: number;
    appStepLaunchTimeout?: number;

    // Ionic livereload properties
    ionicLiveReload?: boolean;
    devServerPort?: number;
    devServerAddress?: string;
    devServerTimeout?: number;

    // Chrome debug properties
    url?: string;
    userDataDir?: string;
    runtimeExecutable?: string;
    runtimeArgs?: string[];

    // Cordova-simulate properties
    simulatePort?: number;
    livereload?: boolean;
    forceprepare?: boolean;
    simulateTempDir?: string;
    corsproxy?: boolean;
    runArguments?: string[];
    cordovaExecutable?: string;
    envFile?: string;
    env?: any;
}

export interface ICordovaCommonRequestArgs extends ICommonRequestArgs {
    // Workaround to suit interface ICommonRequestArgs with launch.json cwd argument
    cwd?: string;
}

// `RSIDZTW<NL` are process status codes (as per `man ps`), skip them
const PS_FIELDS_SPLITTER_RE = /\s+(?:[RSIDZTW<NL]\s+)?/;


// Keep in sync with sourceMapPathOverrides package.json default values

export class CordovaDebugAdapter2 {
    private static SIMULATE_TARGETS: string[] = ["default", "chrome", "chromium", "edge", "firefox", "ie", "opera", "safari"];
    private static pidofNotFoundError = "/system/bin/sh: pidof: not found";
    // Workaround to handle breakpoint location requests correctly on some platforms

    private outputLogger: (message: string, error?: boolean | string) => void;

    public constructor() {
        // Bit of a hack, but chrome-debug-adapter-core no longer provides a way to access the transformer.
    }

    public static getRunArguments(projectRoot: string): Q.Promise<string[]> {
        return CordovaDebugAdapter2.sendMessage(projectRoot, messaging.ExtensionMessage.GET_RUN_ARGUMENTS);
    }

    public static getCordovaExecutable(projectRoot: string): Q.Promise<string> {
        return CordovaDebugAdapter2.sendMessage(projectRoot, messaging.ExtensionMessage.GET_CORDOVA_EXECUTABLE);
    }

    private static retryAsync<T>(func: () => Q.Promise<T>, condition: (result: T) => boolean, maxRetries: number, iteration: number, delay: number, failure: string): Q.Promise<T> {
        const retry = () => {
            if (iteration < maxRetries) {
                return Q.delay(delay).then(() => CordovaDebugAdapter2.retryAsync(func, condition, maxRetries, iteration + 1, delay, failure));
            }

            throw new Error(failure);
        };

        return func()
            .then(result => {
                if (condition(result)) {
                    return result;
                }

                return retry();
            },
            retry);
    }

    private static sendMessage(projectRoot: string, extensionMessage: messaging.ExtensionMessage): Q.Promise<any> {
        return new messaging.ExtensionMessageSender(projectRoot).sendMessage(extensionMessage, [projectRoot])
            .catch(err => {
                throw new Error(`${err.message} Please check whether 'cwd' parameter contains the path to the workspace root directory.`);
            });
    }

    /**
     * Target type for telemetry
     */
    // ios-webkit-debug-proxy work on a rather old version of Chrome DevTools and doesn't support breakpoints location request
    // so we need to filter out breakpoint locations requests from iOS device/emulator debugging sessions to avoid errors

    public isSimulateTarget(target: string) {
        return CordovaDebugAdapter2.SIMULATE_TARGETS.indexOf(target) > -1;
    }

    public attachAndroid(attachArgs: any): Q.Promise<IAttachRequestArgs> {
        let errorLogger = (message: string) => this.outputLogger(message, true);
        // Determine which device/emulator we are targeting

        // For devices we look for "device" string but skip lines with "emulator"
        const deviceFilter = (line: string) => /\w+\tdevice/.test(line) && !/emulator/.test(line);
        const emulatorFilter = (line: string) => /device/.test(line) && /emulator/.test(line);

        let adbDevicesResult: Q.Promise<string> = this.runAdbCommand(["devices"], errorLogger)
            .then<string>((devicesOutput) => {

                const targetFilter = attachArgs.target.toLowerCase() === "device" ? deviceFilter :
                    attachArgs.target.toLowerCase() === "emulator" ? emulatorFilter :
                        (line: string) => line.match(attachArgs.target);

                const result = devicesOutput.split("\n")
                    .filter(targetFilter)
                    .map(line => line.replace(/\tdevice/, "").replace("\r", ""))[0];

                if (!result) {
                    errorLogger(devicesOutput);
                    throw new Error(`Unable to find target ${attachArgs.target}`);
                }

                return result;
            }, (err: Error): any => {
                let errorCode: string = (<any>err).code;
                if (errorCode && errorCode === "ENOENT") {
                    throw new Error("Unable to find adb. Please ensure it is in your PATH and re-open Visual Studio Code");
                }

                throw err;
            });

        let packagePromise: Q.Promise<string> = Q.nfcall(fs.readFile, path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH))
            .catch((err) => {
                if (err && err.code === "ENOENT") {
                    return Q.nfcall(fs.readFile, path.join(attachArgs.cwd, ANDROID_MANIFEST_PATH_8));
                }
                throw err;
            })
            .then((manifestContents) => {
                let parsedFile = elementtree.XML(manifestContents.toString());
                let packageKey = "package";
                return parsedFile.attrib[packageKey];
            });

        return Q.all([packagePromise, adbDevicesResult])
            .spread((appPackageName: string, targetDevice: string) => {
            let pidofCommandArguments = ["-s", targetDevice, "shell", "pidof", appPackageName];
            let getPidCommandArguments = ["-s", targetDevice, "shell", "ps"];
            let getSocketsCommandArguments = ["-s", targetDevice, "shell", "cat /proc/net/unix"];

            let findAbstractNameFunction = () =>
                // Get the pid from app package name
                this.runAdbCommand(pidofCommandArguments, errorLogger)
                    .then((pid) => {
                        if (pid && /^[0-9]+$/.test(pid.trim())) {
                            return pid.trim();
                        }

                        throw Error(CordovaDebugAdapter2.pidofNotFoundError);

                    }).catch((err) => {
                        if (err.message !== CordovaDebugAdapter2.pidofNotFoundError) {
                            return;
                        }

                        return this.runAdbCommand(getPidCommandArguments, errorLogger)
                            .then((psResult) => {
                                const lines = psResult.split("\n");
                                const keys = lines.shift().split(PS_FIELDS_SPLITTER_RE);
                                const nameIdx = keys.indexOf("NAME");
                                const pidIdx = keys.indexOf("PID");
                                for (const line of lines) {
                                    const fields = line.trim().split(PS_FIELDS_SPLITTER_RE).filter(field => !!field);
                                    if (fields.length < nameIdx) {
                                        continue;
                                    }
                                    if (fields[nameIdx] === appPackageName) {
                                        return fields[pidIdx];
                                    }
                                }
                            });
                    })
                    // Get the "_devtools_remote" abstract name by filtering /proc/net/unix with process inodes
                    .then(pid =>
                        this.runAdbCommand(getSocketsCommandArguments, errorLogger)
                            .then((getSocketsResult) => {
                                const lines = getSocketsResult.split("\n");
                                const keys = lines.shift().split(/[\s\r]+/);
                                const flagsIdx = keys.indexOf("Flags");
                                const stIdx = keys.indexOf("St");
                                const pathIdx = keys.indexOf("Path");
                                for (const line of lines) {
                                    const fields = line.split(/[\s\r]+/);
                                    if (fields.length < 8) {
                                        continue;
                                    }
                                    // flag = 00010000 (16) -> accepting connection
                                    // state = 01 (1) -> unconnected
                                    if (fields[flagsIdx] !== "00010000" || fields[stIdx] !== "01") {
                                        continue;
                                    }
                                    const pathField = fields[pathIdx];
                                    if (pathField.length < 1 || pathField[0] !== "@") {
                                        continue;
                                    }
                                    if (pathField.indexOf("_devtools_remote") === -1) {
                                        continue;
                                    }

                                    if (pathField === `@webview_devtools_remote_${pid}`) {
                                        // Matches the plain cordova webview format
                                        return pathField.substr(1);
                                    }

                                    if (pathField === `@${appPackageName}_devtools_remote`) {
                                        // Matches the crosswalk format of "@PACKAGENAME_devtools_remote
                                        return pathField.substr(1);
                                    }
                                    // No match, keep searching
                                }
                            })
                    );

            return CordovaDebugAdapter2.retryAsync(findAbstractNameFunction, (match) => !!match, 5, 1, 5000, "Unable to find localabstract name of cordova app")
                .then((abstractName) => {
                    // Configure port forwarding to the app
                    let forwardSocketCommandArguments = ["-s", targetDevice, "forward", `tcp:${attachArgs.port}`, `localabstract:${abstractName}`];
                    return this.runAdbCommand(forwardSocketCommandArguments, errorLogger).then(() => {
                        // this.adbPortForwardingInfo = { targetDevice, port: attachArgs.port };
                        console.log("here!");
                    });
                });
        }).then(() => {
            let args: IAttachRequestArgs = JSON.parse(JSON.stringify(attachArgs));
            return args;
        });
    }

    /**
     * Initializes telemetry.
     */

    private runAdbCommand(args, errorLogger): Q.Promise<string> {
        const originalPath = process.env["PATH"];
        if (process.env["ANDROID_HOME"]) {
            process.env["PATH"] += path.delimiter + path.join(process.env["ANDROID_HOME"], "platform-tools");
        }
        return execCommand("adb", args, errorLogger).finally(() => {
            process.env["PATH"] = originalPath;
        });
    }
}
