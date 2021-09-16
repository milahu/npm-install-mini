const startTime = Date.now();

import { lockTree } from './lockTree.js';

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

function npm_install_mini() {

  const pkg = json('package.json');
  const pkgLock = json('package-lock.json');

  // header
  console.log(`${pkg.name}@${pkg.version}: install NPM dependencies`)

  const deptree = lockTree(pkg, pkgLock);

  const store_dir = '.pnpm';
  const doneUnpack = new Set();
  const doneScripts = new Set();
  let numTicks = 0;
  const ticksPerLine = 50;

  deptree.forEach((dep, recurse, depTreePath) => {

    debug(`dep = ${dep.name}@${dep.version}`);
    debug(`depTreePath ${depTreePath.map(dep => `${dep.name}@${dep.version}`).join(' / ')}`);

    process.stdout.write('.'); // tick
    numTicks++;
    if (numTicks % ticksPerLine == 0) process.stdout.write('\n');

    if (dep.dev) return; // ignore devDependencies
    // TODO install devDependencies for root package's lifecycle scripts: prepare prepublish (TODO verify)

    if (!dep.resolved) {
      // root package
      recurse();
      // run lifecycle scripts for root package
      if (pkg.scripts) {
        for (const script of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          if (!(script in pkg.scripts)) continue;
          console.log(`> ${pkg.name}@${pkg.version} ${script}`)
          spawn(['npm', 'run', script]);
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      return; // root package: nothing to unpack
    }

    //console.dir(dep);

    const tgzpath = dep.resolved.replace(/^file:\/\//, '');

    if (tgzpath[0] != '/') {
      throw `invalid tgzpath '${tgzpath}'` // https:// ...
      // this is used in npmlock2nix, so all dep.resolved should start with file:///nix/store/
    }

    const isRootDep = (depTreePath.length == 1);

    const parent = depTreePath[depTreePath.length - 1];

    const dep_path = (isRootDep
      ? `node_modules/${dep.name}`
      : `node_modules/${store_dir}/${parent.name}@${parent.version}/node_modules/${dep.name}`
    );
    
    // we need ../../ (not ../) cos the linkPath is treated as directory (not file)
    const dep_target = (dep.name.includes('/') ? '../../' : '') + (isRootDep
        ? `${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`
      : `../../${dep.name}@${dep.version}/node_modules/${dep.name}`
    );

    const dep_store = `node_modules/${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`

    /*
    console.dir({
      name: dep.name,
      version: dep.version,
      parents: path.map(dep => `${dep.name}@${dep.version}`),
      unpack: [tgzpath, dep_store],
      symlink: [dep_target, dep_path],
    });
    */

    if (doneUnpack.has(`${dep.name}@${dep.version}`)) {
      debug(`already unpacked: ${dep.name}@${dep.version}`);
    }
    else {
      unpack(tgzpath, dep_store);
      doneUnpack.add(`${dep.name}@${dep.version}`);
    }

    if (!fs.existsSync(dep_path)) {
      symlink(dep_path, dep_target);
    }
    else {
      // symlink exists
      const old_target = fs.readlinkSync(dep_path);
      if (old_target != dep_target) {
        throw [
          `ERROR symlink collision`,
          `old symlink: ${dep_path} -> ${old_target}`,
          `new symlink: ${dep_path} -> ${dep_target}`,
        ].join('\n');
      }
    }

    if (isRootDep) {
      // install binaries. for this we must read the dep's package.json
      const dep_store_rel = `../${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`
      const pkg = json(`${dep_store}/package.json`);
      const deep_dir = `node_modules/${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`;
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

    // run lifecycle scripts for dependency
    // run scripts after recurse, so that child-dependencies are installed
    if (doneScripts.has(`${dep.name}@${dep.version}`)) {
      debug(`already done scripts: ${dep.name}@${dep.version}`);
    }
    else {
      const pkg = json(`${dep_store}/package.json`);
      if (pkg.scripts) {
        for (const script of ['preinstall', 'install', 'postinstall']) {
          if (!(script in pkg.scripts)) continue;
          console.log(`> ${pkg.name}@${pkg.version} ${script}`)
          spawn(['npm', 'run', script], { cwd: dep_store });
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      doneScripts.add(`${dep.name}@${dep.version}`);
    }
  })

  // summary
  process.stdout.write('\n'); // newline after ticks
  const deltaTime = (Date.now() - startTime) / 1000;
  console.log(`${pkg.name}@${pkg.version}: installed ${doneUnpack.size} NPM dependencies in ${deltaTime.toFixed(2)} seconds`)
}

npm_install_mini();
