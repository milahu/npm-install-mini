#! /usr/bin/env node

const startTime = Date.now();

import { buildDepTree, parseNpmLockV2Project, LockfileType } from 'snyk-nodejs-lockfile-parser';
// rollup fails to bundle this, cos circular deps https://github.com/rollup/rollup/issues/3805
// add integrity fields
// https://github.com/snyk/nodejs-lockfile-parser/pull/112
// fix typescript build
// https://github.com/abdulhannanali/nodejs-lockfile-parser/pull/1

import * as fs from 'fs';
import * as child_process from 'child_process';
import * as path from 'path';

const read = filePath => fs.readFileSync(filePath, 'utf8');
const json = filePath => JSON.parse(read(filePath));
const mkdir = filePath => {
  debug(`mkdir: ${filePath}`);
  fs.mkdirSync(filePath, { recursive: true });
};
const spawn = (args, opts) => child_process.spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });
const chmod = fs.chmodSync;

const enableDebug = false;
const debug = enableDebug ? console.log : () => null;

const unpack = (archive, to) => {
  mkdir(to);
  debug(`unpack: ${archive} -> ${to}`);
  spawn([
    'tar',
    '-x',
    '-f', archive,
    '-C', to,
    '--strip-components=1', // first component is always "package"
  ]);
};

// "fix" the order of arguments
// in linux terminal, when i say `ln a b`, then ln will add a link from a to b
const symlink = (linkPath, linkTarget) => {
  mkdir(path.dirname(linkPath));
  debug(`symlink: ${linkPath} -> ${linkTarget}`);
  fs.symlinkSync(linkTarget, linkPath);
};



async function getDepgraph(lockfilePath) {
  const depgraph = await parseNpmLockV2Project(
    read('package.json'),
    read(lockfilePath),
    {
      // TODO?
      includeDevDeps: true,
      strictOutOfSync: true,
      includeOptionalDeps: true,
    }
  );

  // we need depgraphData to get GraphNode deps
  // https://github.com/snyk/dep-graph/blob/master/src/core/types.ts
  const depgraphData = depgraph.toJSON();

  const depgraphNodesById = {};
  for (const node of depgraphData.graph.nodes) {
    depgraphNodesById[node.nodeId] = node;
  }
  // remove the root node
  //delete depgraphNodesById['root-node']

  depgraphData.nodesById = depgraphNodesById;

  function walk_depgraph(depgraphData, enter, _seen, depPath = []) {
    const isRootPkg = depPath.length == 0
    const node = (isRootPkg
      ? depgraphData.graph.nodes[0] // root node
      : depgraphData.nodesById[depPath[depPath.length - 1].nameVersion]
    )

    const version = node.pkgId.replace(/.*@/, '')
    const name = node.pkgId.slice(0, -1*version.length - 1)

    const resolved = isRootPkg ? "" : node.info.labels.resolved
    const integrity = isRootPkg ? "" : node.info.labels.integrity

    const dep = {
      nameVersion: node.pkgId,
      name,
      version,
      resolved,
      integrity,
    }

    /* this would deduplicate
    if (!_seen) { _seen = new Set() }
    if (_seen.has(depgraphData)) { return }
    _seen.add(depgraphData)
    */

    function recurse() {
      for (const {nodeId: childNodeId} of node.deps) {
        if (depPath.find(d => d.nameVersion == childNodeId)) {
          // found cycle in graph
          //console.log(`found cycle in graph: ${depPath.map(d => d.nameVersion).join('/')}/${childNodeId}`)
          return
        }

        const version = childNodeId.replace(/.*@/, '')
        const name = childNodeId.slice(0, -1*version.length - 1)
        const node = depgraphData.nodesById[childNodeId]

        const resolved = node.info.labels.resolved
        const integrity = node.info.labels.integrity

        const childDep = {
          nameVersion: childNodeId,
          name,
          version,
          resolved,
          integrity,
        }

        walk_depgraph(depgraphData, enter, _seen, depPath.concat([childDep]))
      }
    }

    enter(dep, recurse, depPath)
  }

  return [
    depgraphData,
    walk_depgraph,
  ]
}



async function getDeptree(lockfilePath) {
  const deptree = await buildDepTree( // https://github.com/snyk/nodejs-lockfile-parser/blob/master/lib/index.ts
    read('package.json'),
    read(lockfilePath),
    true, // includeDev: devDependencies are required for build
    lockfileTypeOfName[path.basename(lockfilePath)],
    true, // strictOutOfSync
  );

  function walk_deptree(_this, enter, _seen, depPath = []) {
    /* this would deduplicate
    if (!_seen) { _seen = new Set() }
    if (_seen.has(_this)) { return }
    _seen.add(_this)
    */
    function recurse() {
      for (let key in _this.dependencies) {
        walk_deptree(_this.dependencies[key], enter, _seen, depPath.concat([_this]))
      }
    }
    enter(_this, recurse, depPath)
  }

  return [
    deptree,
    walk_deptree,
  ]
}



async function npm_install_mini() {

  const pkg = json('package.json');
  const pkgLock = json('package-lock.json');
  const preInstallLinks = JSON.parse(process.env.NODE_preInstallLinks || 'null'); // passed by npmlock2nix

  // header
  console.log(`${pkg.name}@${pkg.version}: install NPM dependencies`)

  const lockfileDefaultList = [ 'yarn.lock', 'package-lock.json' ];
  const lockfileTypeOfName = {
    'package-lock.json': LockfileType.npm,
    'yarn.lock': LockfileType.yarn,
  };
  let lockfilePath = process.env.NODE_lockfilePath || null;
  if (!lockfilePath) {
    debug('auto-detect lockfile')
    for (const p of lockfileDefaultList) {
      if (!fs.existsSync(p)) continue;
      lockfilePath = p;
      debug(`found lockfile ${p}`)
      break;
    }
    if (!lockfilePath) throw new Error('not found lockfile');
  }

  const lockfileContent = read(lockfilePath);
  const lockfile = JSON.parse(lockfileContent);

  // npm lockfile version 2 ist not supported by the deptree API
  // so we must use the depgraph API

  // https://github.com/snyk/nodejs-lockfile-parser
  //
  // Dep graph generation supported for:
  //
  // - package-lock.json (at Versions 2 and 3)
  // - yarn.lock
  //
  // Legacy dep tree supported for:
  //
  // - package-lock.json
  // - yarn 1 yarn.lock
  // - yarn 2 yarn.lock

  const [deps, walk_deps] = (
    lockfile.lockfileVersion == 2 ? await getDepgraph(lockfilePath) :
    await getDeptree(lockfilePath)
  )

  const store_dir = '.pnpm';
  const doneUnpack = new Set();
  const doneScripts = new Set();
  let numTicks = 0;
  const ticksPerLine = 50;
  const showTicks = false;

  walk_deps(deps, function enter(dep, recurse, depPath) {

    // TODO write to logfile. printing many lines to terminal is slow
    debug(`+ ${depPath.slice(1).concat([dep]).map(d => `${d.name}@${d.version}`).join(' ')}`);
    //if (!enableDebug) console.log(`${depPath.map(_ => `+ `).join('')}${dep.name}@${dep.version}`);
    // output on:  @nodegui/nodegui@0.37.3: installed 535 NPM dependencies in 37.51 seconds
    // output off: 

    if (showTicks) {
      process.stdout.write('.'); // tick
      numTicks++;
      if (numTicks % ticksPerLine == 0) process.stdout.write('\n');
    }

    const isRootDep = (depPath.length == 1); // dep is a "root dependency" = required by the root package

    dep.nameVersion = `${dep.name}@${dep.version}`;
    if (!enableDebug && isRootDep) {
      console.log(`+ ${dep.nameVersion}`);
    }

    if (!dep.resolved) {
      // root package
      recurse();
      // run lifecycle scripts for root package
      if (pkg.scripts) {
        for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          if (!(scriptName in pkg.scripts)) continue;
          console.log(`> ${pkg.name}@${pkg.version} ${scriptName}: ${pkg.scripts[scriptName]}`)
          spawn(['npm', 'run', scriptName]);
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      return; // root package: nothing to unpack. dependencies are installed in recurse
    }

    const tgzpath = dep.resolved.replace(/^file:\/\//, '');

    if (tgzpath[0] != '/' ) {

      // debug
      //console.log(`invalid tgzpath '${tgzpath}'`);
      //recurse(); return;

      throw new Error(`invalid tgzpath '${tgzpath}'`) // https:// ...
      // this is used in npmlock2nix, so all dep.resolved should start with file:///nix/store/
    }

    const parent = depPath[depPath.length - 1];
    parent.nameVersion = `${parent.name}@${parent.version}`;
    parent.nameVersionStore = parent.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm

    dep.nameVersion = `${dep.name}@${dep.version}`;
    dep.nameVersionStore = dep.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm

    // nameVersionStore: in the first level of store_dir, all names are escaped

    const dep_path = (isRootDep
      ? `node_modules/${dep.name}`
      : `node_modules/${store_dir}/${parent.nameVersionStore}/node_modules/${dep.name}`
    );

    dep.nameEscaped = dep.name.replace(/[/]/g, '+'); // escape / with + like pnpm
    const dep_target = (dep.name.includes('/') ? '../' : '') + (isRootDep
    //const dep_target = (isRootDep
        ? `${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      : `../../${dep.nameVersionStore}/node_modules/${dep.name}`
    );

    const dep_store = `node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`;

    (enableDebug &&
    console.dir({
      name: dep.name,
      version: dep.version,
      parents: depPath.map(d => `${d.name}@${d.version}`),
      unpack: [tgzpath, dep_store],
      symlink: [dep_target, dep_path],
    })
    );

    if (doneUnpack.has(dep.nameVersion)) {
      debug(`already unpacked: ${dep.nameVersion}`);
    }
    else {
      unpack(tgzpath, dep_store);
      doneUnpack.add(dep.nameVersion);
    }

    if (!fs.existsSync(dep_path)) {
      symlink(dep_path, dep_target);
    }
    else {
      // symlink exists
      const old_target = fs.readlinkSync(dep_path);
      if (old_target != dep_target) {
        throw new Error([
          `ERROR symlink collision`,
          `old symlink: ${dep_path} -> ${old_target}`,
          `new symlink: ${dep_path} -> ${dep_target}`,
        ].join('\n'));
      }
    }

    if (isRootDep) {
      // install binaries. for this we must read the dep's package.json
      const dep_store_rel = `../${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      const pkg = json(`${dep_store}/package.json`);
      const deep_dir = `node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`;
      if (typeof pkg.bin == 'string') {
        symlink(`node_modules/.bin/${dep.name}`, `${dep_store_rel}/${pkg.bin}`)
        symlink(`${deep_dir}/node_modules/.bin/${dep.name}`, `../../${pkg.bin}`)
        chmod(`${dep_store}/${pkg.bin}`, 0o755) // fix permissions. required for patchShebangs in nixos
      }
      else if (typeof pkg.bin == 'object') {
        for (const binName of Object.keys(pkg.bin)) {
          // TODO resolve realpath for link target
          // pkg.bin[binName] can be ./cli.js -> should be only cli.js
          symlink(`node_modules/.bin/${binName}`, `${dep_store_rel}/${pkg.bin[binName]}`); // TODO handle collisions
          symlink(`${deep_dir}/node_modules/.bin/${binName}`, `../../${pkg.bin[binName]}`); // TODO handle collisions
          chmod(`${dep_store}/${pkg.bin[binName]}`, 0o755) // fix permissions. required for patchShebangs in nixos
        }
      }
    }

    recurse();

    if (dep.name in preInstallLinks) {
      // symlink files from /nix/store
      for (const linkPath in preInstallLinks[dep.name]) {
        const linkTarget = preInstallLinks[dep.name][linkPath];
        console.log(`> ${dep.name}@${dep.version}: add symlink from preInstallLinks: ${linkPath} -> ${linkTarget}`)
        if (fs.existsSync(`${dep_store}/${linkPath}`)) {
          console.log(`> remove existing file ${dep_store}/${linkPath}`)
          fs.unlinkSync(`${dep_store}/${linkPath}`); // TODO also 'rm -rf' directories
        }
        symlink(`${dep_store}/${linkPath}`, linkTarget); // TODO handle collisions
      }
    }

    // run lifecycle scripts for dependency
    // run scripts after recurse, so that child-dependencies are installed
    if (doneScripts.has(dep.nameVersion)) {
      debug(`already done scripts: ${dep.name}@${dep.version}`);
    }
    else {
      const pkg = json(`${dep_store}/package.json`);
      if (pkg.scripts) {
        for (const scriptName of ['preinstall', 'install', 'postinstall']) {
          if (!(scriptName in pkg.scripts)) continue;
          console.log(`> ${pkg.name}@${pkg.version} ${scriptName}: ${pkg.scripts[scriptName]}`)

          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
          const spawnResult = spawn(['npm', 'run', scriptName], {
            cwd: dep_store,
            env: {
              NODE_PATH: `/build/node_modules/${store_dir}/${dep.nameVersionStore}`, // resolve child-dependencies
            }
          });
          if (spawnResult.status > 0) throw new Error(`ERROR in ${pkg.name}@${pkg.version} ${scriptName}`)
        }
      }
      doneScripts.add(dep.nameVersion);
    }
  })

  // summary
  if (showTicks) process.stdout.write('\n'); // newline after ticks
  const deltaTime = (Date.now() - startTime) / 1000;
  console.log(`${pkg.name}@${pkg.version}: installed ${doneUnpack.size} NPM dependencies in ${deltaTime.toFixed(2)} seconds`)
}

npm_install_mini();
