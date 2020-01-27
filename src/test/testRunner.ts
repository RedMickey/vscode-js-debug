/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import Mocha from 'mocha';
import * as glob from 'glob';
import { use } from 'chai';
import { join } from 'path';

use(require('chai-subset'));

function setupCoverage() {
  const NYC = require('nyc');
  const nyc = new NYC({
    cwd: join(__dirname, '..', '..', '..'),
    exclude: ['**/test/**', '.vscode-test/**'],
    reporter: ['text', 'html'],
    all: true,
    instrument: true,
    hookRequire: true,
    hookRunInContext: true,
    hookRunInThisContext: true,
  });

  nyc.reset();
  nyc.wrap();

  return nyc;
}

export async function run(): Promise<void> {
  const nyc = process.env.COVERAGE ? setupCoverage() : null;

  const mochaOpts = {
    timeout: 10 * 1000,
    ...JSON.parse(process.env.PWA_TEST_OPTIONS || '{}'),
  };

  const logTestReporterPathRelativeToMocha = '../../../out/src/test/reporters/logTestReporter'; // yikes
  const goldenTextReporterPathRelativeToMocha =
    '../../../out/src/test/reporters/goldenTextReporter';

  mochaOpts.reporter = 'mocha-multi-reporters';
  mochaOpts.reporterOptions = {
    reporterEnabled: `${logTestReporterPathRelativeToMocha}, ${goldenTextReporterPathRelativeToMocha}`,
    // reporterEnabled: goldenTextReporterPathRelativeToMocha
    // reporterEnabled: logTestReporterPathRelativeToMocha
  };
  if (process.env.BUILD_ARTIFACTSTAGINGDIRECTORY) {
    mochaOpts.reporterOptions = {
      reporterEnabled: `${logTestReporterPathRelativeToMocha}, ${goldenTextReporterPathRelativeToMocha}, mocha-junit-reporter`,
      mochaJunitReporterReporterOptions: {
        testsuitesTitle: `tests ${process.platform}`,
        mochaFile: join(
          process.env.BUILD_ARTIFACTSTAGINGDIRECTORY,
          `test-results/TEST-${process.platform}-test-results.xml`,
        ),
      },
    };
  }

  const runner = new Mocha(mochaOpts);

  runner.useColors(true);

  // todo: retry failing tests https://github.com/microsoft/vscode-pwa/issues/28
  if (process.env.RETRY_TESTS) {
    runner.retries(Number(process.env.RETRY_TESTS));
  }

  runner.addFile(join(__dirname, 'testIntegrationUtils'));
  runner.addFile(join(__dirname, 'infra/infra'));
  runner.addFile(join(__dirname, 'breakpoints/breakpointsTest'));
  runner.addFile(join(__dirname, 'browser/framesTest'));
  runner.addFile(join(__dirname, 'browser/browserPathResolverTest'));
  runner.addFile(join(__dirname, 'evaluate/evaluate'));
  runner.addFile(join(__dirname, 'sources/sourcesTest'));
  runner.addFile(join(__dirname, 'stacks/stacksTest'));
  runner.addFile(join(__dirname, 'threads/threadsTest'));
  runner.addFile(join(__dirname, 'variables/variablesTest'));
  runner.addFile(join(__dirname, 'console/consoleFormatTest'));
  runner.addFile(join(__dirname, 'console/consoleAPITest'));
  runner.addFile(join(__dirname, 'extension/nodeConfigurationProvidersTests'));

  for (const file of glob.sync('**/*.test.js', { cwd: __dirname })) {
    runner.addFile(join(__dirname, file));
  }

  try {
    await new Promise((resolve, reject) =>
      runner.run(failures =>
        failures ? reject(new Error(`${failures} tests failed`)) : resolve(),
      ),
    );
  } finally {
    if (nyc) {
      nyc.writeCoverageFile();
      nyc.report();
    }
  }
}
