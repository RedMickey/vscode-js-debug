// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import {
  ILauncher,
  ITarget,
  ILaunchResult,
  ILaunchContext,
  IStopMetadata,
} from '../../../targets/targets';
import { IRawTelemetryReporter } from '../../../telemetry/telemetryReporter';
import { AnyLaunchConfiguration } from '../../../configuration';
import { IDisposable, EventEmitter } from '../../../common/events';

export class CordovaLauncher implements ILauncher {
  private _disposables: IDisposable[] = [];
  private _onTerminatedEmitter = new EventEmitter<IStopMetadata>();
  readonly onTerminated = this._onTerminatedEmitter.event;
  private _onTargetListChangedEmitter = new EventEmitter<void>();
  readonly onTargetListChanged = this._onTargetListChangedEmitter.event;

  public async launch(
    params: AnyLaunchConfiguration,
    context: ILaunchContext,
    rawTelemetryReporter: IRawTelemetryReporter,
  ): Promise<ILaunchResult> {



    return { blockSessionTermination: false };
  }

  public async terminate(): Promise<void> {

  }

  async disconnect(): Promise<void> {

  }

  async restart(): Promise<void> {

  }

  targetList(): ITarget[] {
    return [];
  }

  dispose() {
    for (const disposable of this._disposables) disposable.dispose();
    this._disposables = [];
  }

}
