// @flow strict-local

import type {
  Asset,
  BuildEvent,
  BundleGraph,
  Dependency,
  FilePath,
  InitialParcelOptions,
  NamedBundle,
} from '@parcel/types';
import type WorkerFarm from '@parcel/workers';

import invariant from 'assert';
import util from 'util';
import Parcel, {createWorkerFarm} from '@parcel/core';
import assert from 'assert';
import vm from 'vm';
import {NodeFS, MemoryFS, OverlayFS, ncp as _ncp} from '@parcel/fs';
import path from 'path';
import url from 'url';
import WebSocket from 'ws';
import nullthrows from 'nullthrows';
import postHtmlParse from 'posthtml-parser';
import postHtml from 'posthtml';

import {makeDeferredWithPromise, normalizeSeparators} from '@parcel/utils';
import _chalk from 'chalk';
import resolve from 'resolve';
import {NodePackageManager} from '@parcel/package-manager';

export const workerFarm = (createWorkerFarm(): WorkerFarm);
export const inputFS: NodeFS = new NodeFS();
export let outputFS: MemoryFS = new MemoryFS(workerFarm);
export let overlayFS: OverlayFS = new OverlayFS(outputFS, inputFS);

beforeEach(() => {
  outputFS = new MemoryFS(workerFarm);
  overlayFS = new OverlayFS(outputFS, inputFS);
});

// Recursively copies a directory from the inputFS to the outputFS
export async function ncp(source: FilePath, destination: FilePath) {
  await _ncp(inputFS, source, outputFS, destination);
}

// Mocha is currently run with exit: true because of this issue preventing us
// from properly ending the workerfarm after the test run:
// https://github.com/nodejs/node/pull/28788
//
// TODO: Remove exit: true in .mocharc.json and instead add the following in this file:
//   // Spin down the worker farm to stop it from preventing the main process from exiting
//   await workerFarm.end();
// when https://github.com/nodejs/node/pull/28788 is resolved.

const chalk = new _chalk.Instance({enabled: true});
const warning = chalk.keyword('orange');

/* eslint-disable no-console */
// $FlowFixMe
console.warn = (...args) => {
  // eslint-disable-next-line no-console
  console.error(warning(...args));
};
/* eslint-enable no-console */

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function normalizeFilePath(filePath: string): FilePath {
  return normalizeSeparators(filePath);
}

export const distDir: string = path.resolve(
  __dirname,
  '..',
  '..',
  'integration-tests',
  'dist',
);

export async function removeDistDirectory() {
  await outputFS.rimraf(distDir);
}

export function symlinkPrivilegeWarning() {
  // eslint-disable-next-line no-console
  console.warn(
    `-----------------------------------
Skipping symbolic link test(s) because you don't have the privilege.
Run tests with Administrator privilege.
If you don't know how, check here: https://bit.ly/2UmWsbD
-----------------------------------`,
  );
}

export function bundler(
  entries: FilePath | Array<FilePath>,
  opts?: InitialParcelOptions,
): Parcel {
  return new Parcel({
    entries,
    shouldDisableCache: true,
    logLevel: 'none',
    defaultConfig: path.join(__dirname, '.parcelrc-no-reporters'),
    inputFS,
    outputFS,
    workerFarm,
    distDir,
    packageManager: new NodePackageManager(opts?.inputFS || inputFS),
    defaultEngines: {
      browsers: ['last 1 Chrome version'],
      node: '8',
    },
    shouldContentHash: true,
    ...opts,
  });
}

export function findAsset(
  bundleGraph: BundleGraph<NamedBundle>,
  assetFileName: string,
): ?Asset {
  return bundleGraph.traverseBundles((bundle, context, actions) => {
    let asset = bundle.traverseAssets((asset, context, actions) => {
      if (path.basename(asset.filePath) === assetFileName) {
        actions.stop();
        return asset;
      }
    });
    if (asset) {
      actions.stop();
      return asset;
    }
  });
}

export function findDependency(
  bundleGraph: BundleGraph<NamedBundle>,
  assetFileName: string,
  moduleSpecifier: string,
): Dependency {
  let asset = nullthrows(
    findAsset(bundleGraph, assetFileName),
    `Couldn't find asset ${assetFileName}`,
  );

  let dependency = bundleGraph
    .getDependencies(asset)
    .find(d => d.moduleSpecifier === moduleSpecifier);
  invariant(
    dependency != null,
    `Couldn't find dependency ${assetFileName} -> ${moduleSpecifier}`,
  );
  return dependency;
}

export function assertDependencyWasDeferred(
  bundleGraph: BundleGraph<NamedBundle>,
  assetFileName: string,
  moduleSpecifier: string,
): void {
  let dep = findDependency(bundleGraph, assetFileName, moduleSpecifier);
  invariant(
    bundleGraph.isDependencySkipped(dep),
    util.inspect(dep) + " wasn't deferred",
  );
}

export async function bundle(
  entries: FilePath | Array<FilePath>,
  opts?: InitialParcelOptions,
): Promise<BundleGraph<NamedBundle>> {
  return (await bundler(entries, opts).run()).bundleGraph;
}

export function getNextBuild(b: Parcel): Promise<BuildEvent> {
  return new Promise((resolve, reject) => {
    let subscriptionPromise = b
      .watch((err, buildEvent) => {
        if (err) {
          reject(err);
          return;
        }

        subscriptionPromise
          .then(subscription => {
            // If the watch callback was reached, subscription must have been successful
            invariant(subscription != null);
            return subscription.unsubscribe();
          })
          .then(() => {
            // If the build promise hasn't been rejected, buildEvent must exist
            invariant(buildEvent != null);
            resolve(buildEvent);
          })
          .catch(reject);
      })
      .catch(reject);
  });
}

type RunOpts = {require?: boolean, ...};

export async function runBundles(
  bundleGraph: BundleGraph<NamedBundle>,
  parent: NamedBundle,
  bundles: Array<NamedBundle>,
  globals: mixed,
  opts: RunOpts = {},
): Promise<mixed> {
  let entryAsset = nullthrows(
    bundles
      .map(b => b.getMainEntry() || b.getEntryAssets()[0])
      .filter(Boolean)[0],
  );
  let env = entryAsset.env;
  let target = entryAsset.env.context;

  let ctx, promises;
  switch (target) {
    case 'browser': {
      let prepared = prepareBrowserContext(parent.filePath, globals);
      ctx = prepared.ctx;
      promises = prepared.promises;
      break;
    }
    case 'node':
    case 'electron-main':
      ctx = prepareNodeContext(parent.filePath, globals);
      break;
    case 'electron-renderer': {
      let browser = prepareBrowserContext(parent.filePath, globals);
      ctx = {
        ...browser.ctx,
        ...prepareNodeContext(parent.filePath, globals),
      };
      promises = browser.promises;
      break;
    }
    default:
      throw new Error('Unknown target ' + target);
  }

  vm.createContext(ctx);
  for (let b of bundles) {
    new vm.Script(await overlayFS.readFile(nullthrows(b.filePath), 'utf8'), {
      filename: b.name,
    }).runInContext(ctx);
  }

  if (promises) {
    // await any ongoing dynamic imports during the run
    await Promise.all(promises);
  }

  if (opts.require !== false) {
    switch (env.outputFormat) {
      case 'global':
        if (env.scopeHoist) {
          return typeof ctx.output !== 'undefined' ? ctx.output : undefined;
        } else {
          for (let key in ctx) {
            if (key.startsWith('parcelRequire')) {
              // $FlowFixMe
              return ctx[key](bundleGraph.getAssetPublicId(entryAsset));
            }
          }
        }
        return;
      case 'commonjs':
        invariant(typeof ctx.module === 'object' && ctx.module != null);
        return ctx.module.exports;
      default:
        throw new Error(
          'Unable to run bundle with outputFormat ' + env.outputFormat,
        );
    }
  }

  return ctx;
}

export async function runBundle(
  bundleGraph: BundleGraph<NamedBundle>,
  bundle: NamedBundle,
  globals: mixed,
  opts: RunOpts = {},
): Promise<mixed> {
  if (bundle.type === 'html') {
    let code = await overlayFS.readFile(nullthrows(bundle.filePath));
    let ast = postHtmlParse(code, {
      lowerCaseAttributeNames: true,
    });

    let scripts = [];
    postHtml().walk.call(ast, node => {
      if (node.tag === 'script') {
        let src = url.parse(nullthrows(node.attrs).src);
        if (src.hostname == null) {
          scripts.push(path.join(distDir, nullthrows(src.pathname)));
        }
      }
      return node;
    });

    let bundles = bundleGraph.getBundles();
    return runBundles(
      bundleGraph,
      bundle,
      scripts.map(p => nullthrows(bundles.find(b => b.filePath === p))),
      globals,
      opts,
    );
  } else {
    return runBundles(bundleGraph, bundle, [bundle], globals, opts);
  }
}

export function run(
  bundleGraph: BundleGraph<NamedBundle>,
  globals: mixed,
  opts: RunOpts = {},
  // $FlowFixMe[unclear-type]
): Promise<any> {
  let bundle = nullthrows(
    bundleGraph.getBundles().find(b => b.type === 'js' || b.type === 'html'),
  );
  return runBundle(bundleGraph, bundle, globals, opts);
}

export function assertBundles(
  bundleGraph: BundleGraph<NamedBundle>,
  expectedBundles: Array<{|
    name?: string | RegExp,
    type?: string,
    assets: Array<string>,
  |}>,
) {
  let actualBundles = [];
  const byAlphabet = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1);

  bundleGraph.traverseBundles(bundle => {
    let assets = [];

    bundle.traverseAssets(asset => {
      const name = path.basename(asset.filePath);
      assets.push(name);
    });

    assets.sort(byAlphabet);
    actualBundles.push({
      name: path.basename(nullthrows(bundle.filePath)),
      type: bundle.type,
      assets,
    });
  });

  for (let bundle of expectedBundles) {
    if (!Array.isArray(bundle.assets)) {
      throw new Error(
        'Expected bundle must include an array of expected assets',
      );
    }
    bundle.assets.sort(byAlphabet);
  }

  const byName = (a, b) => {
    if (typeof a.name === 'string' && typeof b.name === 'string') {
      return a.name.localeCompare(b.name);
    }

    return 0;
  };

  const byAssets = (a, b) =>
    a.assets.join(',').localeCompare(b.assets.join(','));
  expectedBundles.sort(byName).sort(byAssets);
  actualBundles.sort(byName).sort(byAssets);
  assert.equal(
    actualBundles.length,
    expectedBundles.length,
    'expected number of bundles mismatched',
  );

  let i = 0;
  for (let bundle of expectedBundles) {
    let actualBundle = actualBundles[i++];
    let name = bundle.name;
    if (name != null) {
      if (typeof name === 'string') {
        assert.equal(actualBundle.name, name);
      } else if (name instanceof RegExp) {
        assert(
          actualBundle.name.match(name),
          `${actualBundle.name} does not match regexp ${name.toString()}`,
        );
      } else {
        // $FlowFixMe
        assert.fail();
      }
    }

    if (bundle.type != null) {
      assert.equal(actualBundle.type, bundle.type);
    }

    if (bundle.assets) {
      assert.deepEqual(actualBundle.assets, bundle.assets);
    }
  }
}

export function normaliseNewlines(text: string): string {
  return text.replace(/(\r\n|\n|\r)/g, '\n');
}

function prepareBrowserContext(
  filePath: FilePath,
  globals: mixed,
): {|
  ctx: vm$Context,
  promises: Array<Promise<mixed>>,
|} {
  // for testing dynamic imports
  const fakeElement = {
    remove() {},
  };

  const head = {
    children: [],
    appendChild(el) {
      head.children.push(el);

      if (el.tag === 'script') {
        let {deferred, promise} = makeDeferredWithPromise();
        promises.push(promise);
        setTimeout(function() {
          vm.runInContext(
            overlayFS.readFileSync(
              path.join(path.dirname(filePath), url.parse(el.src).pathname),
              'utf8',
            ),
            ctx,
          );

          el.onload();
          deferred.resolve();
        }, 0);
      } else if (typeof el.onload === 'function') {
        el.onload();
      }
    },
  };

  let promises = [];

  const fakeDocument = {
    head,
    createElement(tag) {
      return {tag};
    },

    getElementsByTagName() {
      return [head];
    },

    createEvent() {
      // For Vue
      return {timeStamp: Date.now()};
    },

    getElementById() {
      return fakeElement;
    },

    body: {
      appendChild() {
        return null;
      },
    },
    currentScript: {
      src: 'http://localhost/script.js',
    },
  };

  var exports = {};
  var ctx = Object.assign(
    {
      exports,
      module: {exports},
      document: fakeDocument,
      WebSocket,
      console,
      location: {hostname: 'localhost', origin: 'http://localhost'},
      fetch(url) {
        return Promise.resolve({
          async arrayBuffer() {
            let readFilePromise = overlayFS.readFile(
              path.join(path.dirname(filePath), url),
            );
            promises.push(readFilePromise);
            return new Uint8Array(await readFilePromise).buffer;
          },
          text() {
            let readFilePromise = overlayFS.readFile(
              path.join(path.dirname(filePath), url),
              'utf8',
            );
            promises.push(readFilePromise);
            return readFilePromise;
          },
        });
      },
      atob(str) {
        return Buffer.from(str, 'base64').toString('binary');
      },
      btoa(str) {
        return Buffer.from(str, 'binary').toString('base64');
      },
      URL,
    },
    globals,
  );

  ctx.window = ctx.self = ctx;
  return {ctx, promises};
}

const nodeCache = {};
function prepareNodeContext(filePath, globals) {
  let exports = {};
  let req = specifier => {
    // $FlowFixMe
    let res = resolve.sync(specifier, {
      basedir: path.dirname(filePath),
      preserveSymlinks: true,
      extensions: ['.js', '.json'],
      readFileSync: (...args) => {
        return overlayFS.readFileSync(...args);
      },
      isFile: file => {
        try {
          var stat = overlayFS.statSync(file);
        } catch (err) {
          return false;
        }
        return stat.isFile();
      },
      isDirectory: file => {
        try {
          var stat = overlayFS.statSync(file);
        } catch (err) {
          return false;
        }
        return stat.isDirectory();
      },
    });

    // Shim FS module using overlayFS
    if (res === 'fs') {
      return {
        readFile: async (file, encoding, cb) => {
          let res = await overlayFS.readFile(file, encoding);
          cb(null, res);
        },
        readFileSync: (file, encoding) => {
          return overlayFS.readFileSync(file, encoding);
        },
      };
    }

    if (res === specifier) {
      // $FlowFixMe
      return require(specifier);
    }

    if (nodeCache[res]) {
      return nodeCache[res].module.exports;
    }

    let ctx = prepareNodeContext(res, globals);
    nodeCache[res] = ctx;

    vm.createContext(ctx);
    vm.runInContext(
      '"use strict";\n' + overlayFS.readFileSync(res, 'utf8'),
      ctx,
    );
    return ctx.module.exports;
  };

  var ctx = Object.assign(
    {
      module: {exports, require: req},
      exports,
      __filename: filePath,
      __dirname: path.dirname(filePath),
      require: req,
      console,
      process: process,
      setTimeout: setTimeout,
      setImmediate: setImmediate,
    },
    globals,
  );

  ctx.global = ctx;
  return ctx;
}

export function shallowEqual(
  a: $Shape<{|+[string]: mixed|}>,
  b: $Shape<{|+[string]: mixed|}>,
): boolean {
  if (Object.keys(a).length !== Object.keys(b).length) {
    return false;
  }

  for (let [key, value] of Object.entries(a)) {
    if (!b.hasOwnProperty(key) || b[key] !== value) {
      return false;
    }
  }

  return true;
}
