// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import * as elementtree from "elementtree";
import * as fs from "fs";
import * as http from "http";
import * as messaging from "./common/extensionMessaging";
import * as path from "path";
import * as Q from "q";
// import * as simulate from "cordova-simulate";

// import {settingsHome} from "./utils/settingsHelper";
import {DebugProtocol} from "vscode-debugprotocol";
import {IAttachRequestArgs, ICommonRequestArgs} from "vscode-chrome-debug-core";
import {execCommand, cordovaRunCommand} from "./debugger/extension";
import {CordovaProjectHelper} from "./utils/cordovaProjectHelper";
import {CordovaIosDeviceLauncher} from "./debugger/cordovaIosDeviceLauncher";

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

export interface ISimulateTelemetryProperties {
  platform?: string;
  target: string;
  port: number;
  simulatePort?: number;
  livereload?: boolean;
  forceprepare?: boolean;
}

export interface IProjectType {
  ionic: boolean;
  ionic2: boolean;
  ionic4: boolean;
  meteor: boolean;
  mobilefirst: boolean;
  phonegap: boolean;
  cordova: boolean;
}

export interface SimulationInfo {
  appHostUrl: string;
  simHostUrl: string;
  urlRoot: string;
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
    private ionicDevServerUrls: string[];
    // private simulateDebugHost: SocketIOClient.Socket;
    // private attachedDeferred: Q.Deferred<void>;

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

    public attachIos(attachArgs: ICordovaAttachRequestArgs): Q.Promise<IAttachRequestArgs> {
        let target = attachArgs.target.toLowerCase() === "emulator" ? "emulator" : attachArgs.target;
        let workingDirectory = attachArgs.cwd;
        const command = CordovaProjectHelper.getCliCommand(workingDirectory);
        // TODO add env support for attach
        const env = CordovaProjectHelper.getEnvArgument(attachArgs);
        return this.checkIfTargetIsiOSSimulator(target, command, env, workingDirectory).then(() => {
            attachArgs.webkitRangeMin = attachArgs.webkitRangeMin || 9223;
            attachArgs.webkitRangeMax = attachArgs.webkitRangeMax || 9322;
            attachArgs.attachAttempts = attachArgs.attachAttempts || 20;
            attachArgs.attachDelay = attachArgs.attachDelay || 1000;
            // Start the tunnel through to the webkit debugger on the device

            const retry = function<T> (func, condition, retryCount): Q.Promise<T> {
                return CordovaDebugAdapter2.retryAsync(func, condition, retryCount, 1, attachArgs.attachDelay, "Unable to find webview");
            };

            const getBundleIdentifier = (): Q.IWhenable<string> => {
                if (attachArgs.target.toLowerCase() === "device") {
                    return CordovaIosDeviceLauncher.getBundleIdentifier(attachArgs.cwd)
                        .then(CordovaIosDeviceLauncher.getPathOnDevice)
                        .then(path.basename);
                } else {
                    return Q.nfcall(fs.readdir, path.join(attachArgs.cwd, "platforms", "ios", "build", "emulator")).then((entries: string[]) => {
                        let filtered = entries.filter((entry) => /\.app$/.test(entry));
                        if (filtered.length > 0) {
                            return filtered[0];
                        } else {
                            throw new Error("Unable to find .app file");
                        }
                    });
                }
            };

            const getSimulatorProxyPort = (packagePath): Q.IWhenable<{ packagePath: string; targetPort: number }> => {
                return this.promiseGet(`http://localhost:${attachArgs.port}/json`, "Unable to communicate with ios_webkit_debug_proxy").then((response: string) => {
                    try {
                        let endpointsList = JSON.parse(response);
                        let devices = endpointsList.filter((entry) =>
                            attachArgs.target.toLowerCase() === "device" ? entry.deviceId !== "SIMULATOR"
                                : entry.deviceId === "SIMULATOR"
                        );
                        let device = devices[0];
                        // device.url is of the form 'localhost:port'
                        return {
                            packagePath,
                            targetPort: parseInt(device.url.split(":")[1], 10),
                        };
                    } catch (e) {
                        throw new Error("Unable to find iOS target device/simulator. Please check that \"Settings > Safari > Advanced > Web Inspector = ON\" or try specifying a different \"port\" parameter in launch.json");
                    }
                });
            };

            const findWebViews = ({ packagePath, targetPort }) => {
                return retry(() =>
                    this.promiseGet(`http://localhost:${targetPort}/json`, "Unable to communicate with target")
                        .then((response: string) => {
                            try {
                                const webviewsList = JSON.parse(response);
                                const foundWebViews = webviewsList.filter((entry) => {
                                    if (this.ionicDevServerUrls) {
                                        return this.ionicDevServerUrls.some(url => entry.url.indexOf(url) === 0);
                                    } else {
                                        return entry.url.indexOf(encodeURIComponent(packagePath)) !== -1;
                                    }
                                });
                                if (!foundWebViews.length && webviewsList.length === 1) {
                                    return {
                                        relevantViews: webviewsList,
                                        targetPort,
                                    };
                                }
                                if (!foundWebViews.length) {
                                    throw new Error("Unable to find target app");
                                }
                                return {
                                    relevantViews: foundWebViews,
                                    targetPort,
                                };
                            } catch (e) {
                                throw new Error("Unable to find target app");
                            }
                        }), (result) => result.relevantViews.length > 0, 5);
            };

            const getAttachRequestArgs = (): Q.Promise<IAttachRequestArgs> =>
                CordovaIosDeviceLauncher.startWebkitDebugProxy(attachArgs.port, attachArgs.webkitRangeMin, attachArgs.webkitRangeMax)
                    .then(getBundleIdentifier)
                    .then(getSimulatorProxyPort)
                    .then(findWebViews)
                    .then(({ relevantViews, targetPort }) => {
                        return { port: targetPort, url: relevantViews[0].url };
                    })
                    .then(({ port, url }) => {
                        const args: IAttachRequestArgs = JSON.parse(JSON.stringify(attachArgs));
                        args.port = port;
                        args.url = url;
                        return args;
                    });

            return retry(getAttachRequestArgs, () => true, attachArgs.attachAttempts);
        });
    }

        private checkIfTargetIsiOSSimulator(target: string, cordovaCommand: string, env: any, workingDirectory: string): Q.Promise<void> {
        const simulatorTargetIsNotSupported = () => {
            const message = "Invalid target. Please, check target parameter value in your debug configuration and make sure it's a valid iPhone device identifier. Proceed to https://aka.ms/AA3xq86 for more information.";
            throw new Error(message);
        };
        if (target === "emulator") {
            simulatorTargetIsNotSupported();
        }
        return cordovaRunCommand(cordovaCommand, ["emulate", "ios", "--list"], env, workingDirectory).then((output) => {
            // Get list of emulators as raw strings
            output[0] = output[0].replace(/Available iOS Simulators:/, "");

            // Clean up each string to get real value
            const emulators = output[0].split("\n").map((value) => {
                let match = value.match(/(.*)(?=,)/gm);
                if (!match) {
                    return null;
                }
                return match[0].replace(/\t/, "");
            });

            return (emulators.indexOf(target) >= 0);
        })
        .then((result) => {
            if (result) {
                simulatorTargetIsNotSupported();
            }
        });
    }

    private promiseGet(url: string, reqErrMessage: string): Q.Promise<string> {
      let deferred = Q.defer<string>();
      let req = http.get(url, function(res) {
          let responseString = "";
          res.on("data", (data: Buffer) => {
              responseString += data.toString();
          });
          res.on("end", () => {
              deferred.resolve(responseString);
          });
      });
      req.on("error", (err: Error) => {
          deferred.reject(err);
      });
      return deferred.promise;
  }

      /*private launchSimulate(launchArgs: ICordovaLaunchRequestArgs, projectType: IProjectType): Q.Promise<any> {
        let simulateTelemetryPropts: ISimulateTelemetryProperties = {
            platform: launchArgs.platform,
            target: launchArgs.target,
            port: launchArgs.port,
            simulatePort: launchArgs.simulatePort,
        };

        if (launchArgs.hasOwnProperty("livereload")) {
            simulateTelemetryPropts.livereload = launchArgs.livereload;
        }

        if (launchArgs.hasOwnProperty("forceprepare")) {
            simulateTelemetryPropts.forceprepare = launchArgs.forceprepare;
        }

        let messageSender = new messaging.ExtensionMessageSender(launchArgs.cwd);
        let simulateInfo: SimulationInfo;

        let launchSimulate = Q.resolve(void 0)
            .then(() => {
                let simulateOptions = this.convertLaunchArgsToSimulateArgs(launchArgs);
                return messageSender.sendMessage(messaging.ExtensionMessage.START_SIMULATE_SERVER, [launchArgs.cwd, simulateOptions, projectType]);
            }).then((simInfo: SimulationInfo) => {
                simulateInfo = simInfo;
                return this.connectSimulateDebugHost(simulateInfo);
            }).then(() => {
                launchArgs.userDataDir = path.join(settingsHome(), CordovaDebugAdapter.CHROME_DATA_DIR);
                return messageSender.sendMessage(messaging.ExtensionMessage.LAUNCH_SIM_HOST, [launchArgs.target]);
            }).then(() => {
                // Launch Chrome and attach
                launchArgs.url = simulateInfo.appHostUrl;
                this.outputLogger("Attaching to app");

                return this.launchChrome(launchArgs);
            }).catch((e) => {
                throw e;
            }).then(() => void 0);

        return Q.all([launchSimulate]);
    }

    private convertLaunchArgsToSimulateArgs(launchArgs: ICordovaLaunchRequestArgs): simulate.SimulateOptions {
        let result: simulate.SimulateOptions = {};

        result.platform = launchArgs.platform;
        result.target = launchArgs.target;
        result.port = launchArgs.simulatePort;
        result.livereload = launchArgs.livereload;
        result.forceprepare = launchArgs.forceprepare;
        result.simulationpath = launchArgs.simulateTempDir;
        result.corsproxy = launchArgs.corsproxy;

        return result;
    }

    private connectSimulateDebugHost(simulateInfo: SimulationInfo): Q.Promise<void> {
        // Connect debug-host to cordova-simulate
        let viewportResizeFailMessage = "Viewport resizing failed. Please try again.";
        let simulateDeferred: Q.Deferred<void> = Q.defer<void>();

        let simulateConnectErrorHandler = (err: any): void => {
            this.outputLogger(`Error connecting to the simulated app.`);
            simulateDeferred.reject(err);
        };

        this.simulateDebugHost = io.connect(simulateInfo.urlRoot);
        this.simulateDebugHost.on("connect_error", simulateConnectErrorHandler);
        this.simulateDebugHost.on("connect_timeout", simulateConnectErrorHandler);
        this.simulateDebugHost.on("connect", () => {
            this.simulateDebugHost.on("resize-viewport", (data: simulate.ResizeViewportData) => {
                this.changeSimulateViewport(data).catch(() => {
                    this.outputLogger(viewportResizeFailMessage, true);
                }).done();
            });
            this.simulateDebugHost.on("reset-viewport", () => {
                this.resetSimulateViewport().catch(() => {
                    this.outputLogger(viewportResizeFailMessage, true);
                }).done();
            });
            this.simulateDebugHost.emit("register-debug-host", { handlers: ["reset-viewport", "resize-viewport"] });
            simulateDeferred.resolve(void 0);
        });

        return simulateDeferred.promise;
    }

    private resetSimulateViewport(): Q.Promise<void> {
        return this.attachedDeferred.promise.then(() =>
            this.chrome.Emulation.clearDeviceMetricsOverride()
        ).then(() =>
            this.chrome.Emulation.setEmulatedMedia({media: ""})
        ).then(() =>
            this.chrome.Emulation.resetPageScaleFactor()
        );
    }

    private changeSimulateViewport(data: simulate.ResizeViewportData): Q.Promise<void> {
        return this.attachedDeferred.promise.then(() =>
            this.chrome.Emulation.setDeviceMetricsOverride({
                width: data.width,
                height: data.height,
                deviceScaleFactor: 0,
                mobile: true,
            })
        );
    }*/

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
