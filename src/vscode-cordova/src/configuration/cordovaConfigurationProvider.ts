// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { BaseConfigurationProvider } from '../../../baseConfigurationProvider';
import {
  AnyCordovaConfiguration,
  ResolvingCordovaConfiguration,
  cordovaLaunchDefaults,
  cordovaAttachDefaults,
} from '../../../configuration';
import * as vscode from 'vscode';

export class CordovaDebugConfigurationProvider
  extends BaseConfigurationProvider<AnyCordovaConfiguration>
  implements vscode.DebugConfigurationProvider {

    protected async resolveDebugConfigurationAsync(
    folder: vscode.WorkspaceFolder | undefined,
    config: ResolvingCordovaConfiguration,
  ): Promise<AnyCordovaConfiguration | undefined> {

    return config.request === 'attach'
      ? { ...cordovaAttachDefaults, ...config }
      : { ...cordovaLaunchDefaults, ...config };
  }
}
