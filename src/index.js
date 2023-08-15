#! /usr/bin/env node

const startTime = Date.now();

// add resolved + integrity fields
// https://github.com/snyk/nodejs-lockfile-parser/pull/112
// https://github.com/snyk/nodejs-lockfile-parser/pull/199

import { buildDepTree, parseNpmLockV2Project, LockfileType } from 'snyk-nodejs-lockfile-parser';

import which from 'which';

import fs from 'fs';
import child_process from 'child_process';
import path from 'path';

const read = filePath => fs.readFileSync(filePath, 'utf8');
const json = filePath => JSON.parse(read(filePath));
const mkdir = filePath => {
  enableDebug && debug(`mkdir: ${filePath}`);
  fs.mkdirSync(filePath, { recursive: true });
};
const spawn = (args, opts) => child_process.spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });
const chmod = fs.chmodSync;

const enableDebug = false;
const debug = enableDebug ? console.log : () => null;

const unpack = (archive, to) => {
  mkdir(to);
  enableDebug && debug(`unpack: ${archive} -> ${to}`);
  spawn([
    'tar',
    '-x',
    '-f', archive,
    '-C', to,
    '--strip-components=1', // first component is always "package"
  ]);
};

// FIXME: rewriting symlink /nix/store/47zfvc53hvjmjnvvylxwqj7b8njk9r4v-manyverse-0.2307.3-beta-node-modules/bin to be relative to /nix/store/47zfvc53hvjmjnvvylxwqj7b8njk9r4v-manyverse-0.2307.3-beta-node-modules
// all internal symlinks (with targets in the node-modules derivation) should be relative

const symlink = (linkTarget, linkPath) => {
  enableDebug && debug(`symlink(${linkTarget}, ${linkPath})`);
  mkdir(path.dirname(linkPath));
  fs.symlinkSync(linkTarget, linkPath);
};



function parseShebang(fileText) {
  // parse shebang line of script file
  // note: shebang line length is limited, usually to 127 bytes
  // based on https://github.com/pnpm/cmd-shim
  // see also https://github.com/npm/cmd-shim
  // examples:
  // "#!/bin/sh" -> ["/bin/sh", ""]
  // "#! /usr/bin/bash a b c" -> ["/usr/bin/bash", " a b c"]
  // "#! /usr/bin/env -S bash a b c" -> ["bash", " a b c"]
  // "#! /usr/bin/env -Sbash a b c" -> ["bash", " a b c"]
  const shebangExpr = /^#!\s*(?:\/usr\/bin\/env\s+(?:-S)?)?\s*(\S+)(.*)$/;
  let firstLineEnd = fileText.indexOf('\n');
  if (firstLineEnd == -1) firstLineEnd = fileText.length;
  const firstLine = fileText.slice(0, firstLineEnd).trimRight();
  const shebang = firstLine.match(shebangExpr);
  if (!shebang) return null;
  const [_, arg0, args] = shebang;
  return [arg0, args];
}



// TODO allow to override via command line options
function resolveBinaryPath(name) {
  // command -v $name
  // which $name
}



async function getDepgraph(lockfilePath) {
  const depgraph = await parseNpmLockV2Project(
    read('package.json'),
    read(lockfilePath),
    {
      // devDependencies are required to build the root package from source
      includeDevDeps: true,

      strictOutOfSync: true,

      // optional deps have no resolved+integrity values in lockfile
      includeOptionalDeps: false,
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

  async function walk_depgraph(depgraphData, enter, _seen, depPath = []) {
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

    async function recurse() {
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

        await walk_depgraph(depgraphData, enter, _seen, depPath.concat([childDep]));
      }
    }

    await enter(dep, recurse, depPath);
  }

  return [
    depgraphData,
    walk_depgraph,
  ]
}



async function getDeptree(lockfilePath) {
  // https://github.com/snyk/nodejs-lockfile-parser/blob/master/lib/index.ts
  const deptree = await buildDepTree(
    read('package.json'),
    read(lockfilePath),
    true, // includeDev: devDependencies are required for build
    lockfileTypeOfName[path.basename(lockfilePath)],
    true, // strictOutOfSync
  );

  async function walk_deptree(_this, enter, _seen, depPath = []) {
    /* this would deduplicate
    if (!_seen) { _seen = new Set() }
    if (_seen.has(_this)) { return }
    _seen.add(_this)
    */
    async function recurse() {
      for (let key in _this.dependencies) {
        await walk_deptree(_this.dependencies[key], enter, _seen, depPath.concat([_this]));
      }
    }
    await enter(_this, recurse, depPath);
  }

  return [
    deptree,
    walk_deptree,
  ]
}



const lockfileDefaultList = [ 'yarn.lock', 'package-lock.json' ];

const lockfileTypeOfName = {
  'package-lock.json': LockfileType.npm,
  'yarn.lock': LockfileType.yarn,
};



async function main() {

  // TODO use minimist to parse command line options

  // TODO enable debug via command line options
  // allow writing debug output to logfile

  // TODO allow to change via command line options
  const pkg = json('package.json');
  const pkgLock = json('package-lock.json');

  // passed by npmlock2nix
  // FIXME pass by file
  const preInstallLinks = JSON.parse(process.env.NODE_preInstallLinks || 'null');

  const pkgNameVersion = `${pkg.name}@${pkg.version}`;

  // header
  console.log(`${pkgNameVersion}: install NPM dependencies`)

  let lockfilePath = process.env.NODE_lockfilePath || null;
  if (!lockfilePath) {
    enableDebug && debug('auto-detect lockfile')
    for (const p of lockfileDefaultList) {
      if (!fs.existsSync(p)) continue;
      lockfilePath = p;
      enableDebug && debug(`found lockfile ${p}`)
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

  async function enter(dep, recurse, depPath) {

    // TODO write to logfile. printing many lines to terminal is slow
    enableDebug && debug(`+ ${depPath.slice(1).concat([dep]).map(d => `${d.name}@${d.version}`).join(' ')}`);
    //if (!enableDebug) console.log(`${depPath.map(_ => `+ `).join('')}${dep.name}@${dep.version}`);
    // output on:  @nodegui/nodegui@0.37.3: installed 535 NPM dependencies in 37.51 seconds
    // output off: 

    if (showTicks) {
      process.stdout.write('.'); // tick
      numTicks++;
      if (numTicks % ticksPerLine == 0) process.stdout.write('\n');
    }

    // TODO default false, use command line option
    const ignoreScripts = true;

    //console.log(`depPath: ${depPath.map(d => d.nameVersion).join('  ')}`);

    const isRootPkg = (depPath.length == 0);

    // dep is a "root dependency" = required by the root package
    const isRootDep = (depPath.length == 1);

    dep.nameVersion = `${dep.name}@${dep.version}`;

    if (!enableDebug && isRootDep) {
      console.log(`+ ${dep.nameVersion}`);
    }

    if (isRootPkg) {

      // install all child packages
      await recurse();

      // patch binaries in node_modules/.bin/
      // pnpm uses wrapper scripts, similar to nixpkgs wrapper scripts
      // nixpkgs would move the original binary (original-name) to .original-name.wrapped
      // fix: sh: line 1: /build/node_modules/.bin/patch-package: cannot execute: required file not found
      // fix: sh: line 1: /build/node_modules/.bin/husky: Permission denied

      console.log(`${dep.nameVersion}: patching binaries in node_modules/.bin/`);

      for (const binName of fs.readdirSync('node_modules/.bin')) {

        const binPath = `node_modules/.bin/${binName}`;
        console.log(`${dep.nameVersion}: patching binary ${binPath}`);

        // read the first 127 bytes of the old file
        // to parse the shebang line
        const shebangLineMaxLength = 127; // linux
        const fd = fs.openSync(binPath);
        const buf = new Buffer.alloc(shebangLineMaxLength);
        const readLength = fs.readSync(fd, buf, 0, shebangLineMaxLength, 0);
        fs.closeSync(fd);
        const fileText = buf.toString('utf8', 0, readLength);
        const shebang = parseShebang(fileText);
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: shebang`, shebang);

        // linkTarget is relative to the "node_modules/.bin" directory
        const linkTarget = fs.readlinkSync(binPath);
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: linkTarget`, linkTarget);

        // create wrapper script
        // see also
        // https://github.com/pnpm/pnpm/issues/6937

        const linkTargetParts = linkTarget.split("/node_modules/");
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: linkTargetParts`, linkTargetParts);

        const pkgStoreName = linkTargetParts[0].split("/")[2];
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: pkgStoreName`, pkgStoreName);

        const pkgName = (linkTargetParts[1][0] == "@") ? linkTargetParts[1].split("/").slice(0, 2).join("/") : linkTargetParts[1].split("/")[0];
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: pkgName`, pkgName);

        const linkTargetClean = linkTarget.replace(/\/(?:\.\/)+/g, "/"); // replace /./ with /
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: linkTargetClean`, linkTargetClean);

        // $b: absolute path to node_modules/.bin
        // $p: absolute path to node_modules/.pnpm
        // $n: absolute path to node_modules/.pnpm/${pkgStoreName}/node_modules
        const linkTargetShell = (
          // resolve parent path from $b to $n
          linkTargetClean.startsWith(`../.pnpm/${pkgStoreName}/node_modules/`) ? ("$n" + linkTargetClean.slice(`../.pnpm/${pkgStoreName}/node_modules`.length)) :
          // resolve parent path from $b to $p
          linkTargetClean.startsWith("../.pnpm/") ? ("$p" + linkTargetClean.slice(8)) :
          // keep absolute path
          linkTargetClean.startsWith("/") ? linkTargetClean :
          // use relative path to $b
          ("$b/" + linkTargetClean)
        );
        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: linkTargetShell`, linkTargetShell);

        const linkTargetShellDir = linkTargetShell.replace(/\/[^/]+$/, '');

        const wrapperScriptLines = [
          '#!/bin/sh',
          '',
          'set -e',
          '',
          'b="$(readlink -f "$(dirname "$0")")"', // absolute path of node_modules/.bin
          'p="$(dirname "$b")/.pnpm"', // absolute path of node_modules/.pnpm
          `n="$p/${pkgStoreName}/node_modules"`,
          '',
          [
            'export NODE_PATH="',
            ...(
              // example:
              // linkTargetShellDir = "$n/somepkg/dist/bin"
              // -> add paths:
              // "$n/somepkg/dist/bin/node_modules"
              // "$n/somepkg/dist/node_modules"
              linkTargetShellDir.startsWith(`$n/${pkgName}/`)
              ? (
                linkTargetShellDir.slice(`$n/${pkgName}/`.length).split('/').map(
                  (_val, idx, arr) => `$n/${pkgName}/${arr.slice(0, arr.length - idx).join('/')}/node_modules:`
                )
              )
              : []
            ),
            `$n/${pkgName}/node_modules:`,
            `$n:`,
            '$p/node_modules:',
            '$NODE_PATH"',
          ].join('\\\n'),
          '',

          //`# debug`,
          //`echo "0: $0"`,
          //`echo "b: $b"`,
          //`echo "p: $p"`,
          //`echo "a: $a"`,
          //`echo "NODE_PATH: $NODE_PATH"`,
        ];

        if (!shebang) {
          // no shebang. just exec the file with custom NODE_PATH
          wrapperScriptLines.push(`exec "${linkTargetShell}" "$@"`);
        }
        else {
          const [arg0, args] = shebang;
          if (arg0[0] == '/') {
            // absolute path to the arg0 executable
            wrapperScriptLines.push(`exec ${arg0}${args} "${linkTargetShell}" "$@"`);
          }
          else {
            // executable name via "/usr/bin/env" or "/usr/bin/env -S"
            const arg0Name = arg0;
            // get absolute path of the arg0 executable
            // this throws when arg0Name is not in $PATH
            const arg0Path = await which(arg0Name);
            wrapperScriptLines.push(
              `[ -x "$b/${arg0}" ] &&`,
              `exec "$b/${arg0}" "${linkTargetShell}" "$@"`,
              '',

              // no. this is handled by nodejs-hide-symlinks
              // with a node wrapper in $PATH
              //...(arg0 == 'node' ? [
              //  `LD_PRELOAD=/nix/store/i2wh1abgq9wqsxgpsjgydfhf9n54f06f-nodejs-hide-symlinks-unstable-2021-09-29/lib/libnodejs_hide_symlinks.so \\`,
              //] : []),

              // abolute path to node binary?
              // no. the build environment's $PATH should have these binaries
              // for the runtime environment, the user can generate extra wrapper scripts
              // yes. in the nix store, all calls to binaries should use absolute paths.
              //`exec ${arg0} "${linkTargetShell}" "$@"`,
              `exec "${arg0Path}" "${linkTargetShell}" "$@"`,
            );
          }
        }

        enableDebug && debug(`${dep.nameVersion}: patching binary ${binPath}: wrapperScriptLines`, wrapperScriptLines);

        // replace the symlink in node_modules/.bin with a wrapper script
        fs.unlinkSync(binPath);
        const wrapperScript = wrapperScriptLines.join('\n') + '\n';
        fs.writeFileSync(binPath, wrapperScript, 'utf8');
        chmod(binPath, 0o755);
      }

      enableDebug && debug(`${dep.nameVersion}: dep`, dep);

      // run lifecycle scripts of root package
      // pkg is the parsed package.json
      if (ignoreScripts == false && pkg.scripts) {
        console.log(`${dep.nameVersion}: running lifecycle scripts`)
        for (const scriptName of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          if (!(scriptName in pkg.scripts)) continue;
          console.log(`> ${pkgNameVersion} ${scriptName}: ${pkg.scripts[scriptName]}`)
          spawn(['npm', 'run', scriptName]);
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      // root package: nothing to unpack.
      // dependencies were installed in recurse
      return;
    }

    dep.nameVersion = `${dep.name}@${dep.version}`;

    const parent = depPath[depPath.length - 1];
    enableDebug && debug(`${dep.nameVersion}: parent: ${parent.nameVersion}`);

    const parent = isRootDep ? null : depPath[depPath.length - 2];
    enableDebug && debug(`${dep.nameVersion}: parent: ${parent?.nameVersion}`);

    if (parent) {
      parent.nameVersion = `${parent.name}@${parent.version}`;
      parent.nameVersionStore = parent.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm
    }

    // nameVersionStore: in the first level of store_dir, all names are escaped
    dep.nameVersionStore = dep.nameVersion.replace(/[/]/g, '+'); // escape / with + like pnpm

    const dep_path = (isRootDep
      // create link node_modules/x with target node_modules/.pnpm/x@1/node_modules/x
      ? `node_modules/${dep.name}`
      // create link node_modules/.pnpm/parent@1/node_modules/x with target ../../x@1/node_modules/x
      : `node_modules/${store_dir}/${parent.nameVersionStore}/node_modules/${dep.name}`
    );
    enableDebug && debug(`${dep.nameVersion}: dep_path: ${dep_path}`);

    dep.nameEscaped = dep.name.replace(/[/]/g, '+'); // escape / with + like pnpm
    enableDebug && debug(`${dep.nameVersion}: dep.nameEscaped: ${dep.nameEscaped}`);

    const dep_target = (dep.name.includes('/') ? '../' : '') + (isRootDep
      // create link node_modules/x with target node_modules/.pnpm/x@1/node_modules/x
      ? `${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`
      // create link node_modules/.pnpm/parent@1/node_modules/x with target ../../x@1/node_modules/x
      : `../../${dep.nameVersionStore}/node_modules/${dep.name}`
    );
    enableDebug && debug(`${dep.nameVersion}: dep_target: ${dep_target}`);

    const dep_store = `node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}`;
    enableDebug && debug(`${dep.nameVersion}: dep_store: ${dep_store}`);

    (enableDebug &&
    console.dir({
      name: dep.name,
      version: dep.version,
      parents: depPath.map(d => `${d.name}@${d.version}`),
      unpack: [tgzpath, dep_store],
      symlink: [dep_target, dep_path],
    })
    );

    // dep.resolved is tarfile or directory
    // this is used in npmlock2nix, so all dep.resolved should start with file:///nix/store/ or /nix/store/
    // invalid paths start with https:// or git+ssh:// or ...
    if (dep.resolved.startsWith("file://")) {
      // dep.resolved is tarfile -> unpack
      const tgzpath = dep.resolved.replace(/^file:\/\//, '');
      if (tgzpath[0] != '/' ) {
        console.dir({ dep });
        throw new Error(`invalid tarfile path '${tgzpath}' - expected file:///*.tgz`)
      }
      unpack(tgzpath, dep_store);
    }
    else {
      // dep.resolved is directory -> create symlink
      if (dep.resolved[0] != '/' ) {
        console.dir({ dep });
        throw new Error(`invalid directory path '${dep.resolved}' - expected /*`);
      }

      // create link from machine-level store to local .pnpm/ store
      if (!fs.existsSync(dep_store)) {
        symlink(dep.resolved, dep_store);
      }
    }
    doneUnpack.add(dep.nameVersion);

    // install nested dep
    if (!fs.existsSync(dep_path)) {
      symlink(dep_target, dep_path);
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
        // TODO handle collisions
        symlink(`${dep_store_rel}/${pkg.bin}`, `node_modules/.bin/${dep.name}`);
      }
      else if (typeof pkg.bin == 'object') {
        for (const binName of Object.keys(pkg.bin)) {
          // TODO handle collisions
          symlink(`${dep_store_rel}/${pkg.bin[binName]}`, `node_modules/.bin/${binName}`);
        }
      }
    }

    // install child deps
    await recurse();

    // FIXME read preInstallLinks from file
    //console.dir({ loc: 390, preInstallLinks });

    if (preInstallLinks != null && dep.name in preInstallLinks) {
      // symlink files from /nix/store
      for (const linkPath in preInstallLinks[dep.name]) {
        const linkTarget = preInstallLinks[dep.name][linkPath];
        console.log(`> ${dep.name}@${dep.version}: add symlink from preInstallLinks: ${linkPath} -> ${linkTarget}`)
        if (fs.existsSync(`${dep_store}/${linkPath}`)) {
          console.log(`> remove existing file ${dep_store}/${linkPath}`)
          fs.unlinkSync(`${dep_store}/${linkPath}`); // TODO also 'rm -rf' directories
        }
        try {
          symlink(linkTarget, `${dep_store}/${linkPath}`);
        }
        catch (error) {
          // TODO handle collisions
          throw error;
        }
      }
    }

    // run lifecycle scripts of dependency
    // run scripts after recurse, so that child-dependencies are installed
    if (doneScripts.has(dep.nameVersion)) {
      enableDebug && debug(`already done scripts: ${dep.name}@${dep.version}`);
    }
    else {
      const dep_pkg = json(`${dep_store}/package.json`);
      if (ignoreScripts == false && dep_pkg.scripts) {
        for (const scriptName of ['preinstall', 'install', 'postinstall']) {
          if (!(scriptName in dep_pkg.scripts)) {
            continue;
          }
          console.log(`> ${pkgNameVersion} ${scriptName}: ${dep_pkg.scripts[scriptName]}`)

          const workdir = process.cwd();

          const NODE_PATH = [
            // TODO add paths, see linkTargetShellDir.slice
            `${workdir}/node_modules/${store_dir}/${dep.nameVersionStore}/node_modules/${dep.name}/node_modules`,
            `${workdir}/node_modules/${store_dir}/${dep.nameVersionStore}/node_modules`,
            `${workdir}/node_modules`,
            (process.env.NODE_PATH || ''),
          ].join(':');

          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
          const spawnResult = spawn(['npm', 'run', scriptName], {
            cwd: dep_store,
            env: {
              ...process.env,
              NODE_PATH,
            }
          });
          if (spawnResult.status > 0) {
            throw new Error(`ERROR in ${pkgNameVersion} ${scriptName}`)
          }
        }
      }
      doneScripts.add(dep.nameVersion);
    }
  }

  await walk_deps(deps, enter);

  // summary
  if (showTicks) process.stdout.write('\n'); // newline after ticks
  const deltaTime = (Date.now() - startTime) / 1000;
  console.log(`${pkgNameVersion}: installed ${doneUnpack.size} node modules in ${deltaTime.toFixed(2)} seconds`)

  enableDebug && debug(`ls node_modules:`, fs.readdirSync(`node_modules`).join('  '));
  enableDebug && debug(`ls node_modules/.bin:`, fs.readdirSync(`node_modules/.bin`).join('  '));
}



main();
