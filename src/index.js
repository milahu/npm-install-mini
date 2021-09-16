import { lockTree } from './lockTree.js';

import * as fs from 'fs';
import * as child_process from 'child_process';
import * as path from 'path';

const read = path => fs.readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const mkdir = path => fs.mkdirSync(path, { recursive: true });
const spawn = (args, opts) => child_process.spawnSync(args[0], args.slice(1), { stdio: 'inherit', ...opts });
const chmod = fs.chmodSync;

const unpack = (archive, to) => {
  mkdir(to);
  //console.log(`unpack: ${archive} -> ${to}`);
  spawn([
    'tar',
    '-x',
    '-f', archive,
    '-C', to,
    '--strip-components=1', // first component is always "package"
  ]);
};

const symlink = (from, to) => {
  mkdir(path.dirname(to));
  //console.log(`symlink: ${from} -> ${to}`);
  fs.symlinkSync(from, to);
};

function npm_install_mini() {

  const pkg = json('package.json');
  const pkgLock = json('package-lock.json');

  const deptree = lockTree(pkg, pkgLock);

  const store_dir = '.pnpm';
  const doneUnpack = new Set();
  const doneScripts = new Set();

  deptree.forEach((dep, recurse, path) => {

    //console.log(`dep = ${dep.name}@${dep.version}`);
    //console.log(`path ${path.map(dep => `${dep.name}@${dep.version}`).join(' / ')}`);

    if (dep.dev) return; // ignore devDependencies
    // TODO install devDependencies for root package's lifecycle scripts: prepare prepublish (TODO verify)

    if (!dep.resolved) {
      // root package
      recurse();
      // run lifecycle scripts for root package
      if (pkg.scripts) {
        for (const script of ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare']) {
          if (!(script in pkg.scripts)) continue;
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

    const isRootDop = (path.length == 1);

    const parent = path[path.length - 1];

    const dep_path = (isRootDop
      ? `node_modules/${dep.name}`
      : `node_modules/${store_dir}/${parent.name}@${parent.version}/node_modules/${dep.name}`
    );
    
    const dep_link = (isRootDop
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
      symlink: [dep_link, dep_path],
    });
    */

    if (doneUnpack.has(`${dep.name}@${dep.version}`)) {
      console.log(`already unpacked: ${dep.name}@${dep.version}`);
    }
    else {
      unpack(tgzpath, dep_store);
      doneUnpack.add(`${dep.name}@${dep.version}`);
    }

    try {
      symlink(dep_link, dep_path);
    }
    catch (error) {
      console.log(`symlink failed: ${error}`);
      if (fs.existsSync(dep_path)) {
        const existing_link = fs.readlinkSync(dep_path);
        if (existing_link != dep_link) {
          console.log(`ERROR collision: different symlink exists: ${dep_path} -> ${existing_link}`);
        }
      }
    }

    if (isRootDop) {
      // install binaries. for this we must read the dep's package.json
      const dep_store_rel = `../${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`
      const pkg = json(`${dep_store}/package.json`);
      const deep_dir = `node_modules/${store_dir}/${dep.name}@${dep.version}/node_modules/${dep.name}`;
      if (typeof pkg.bin == 'string') {
        symlink(`${dep_store_rel}/${pkg.bin}`, `node_modules/.bin/${dep.name}`)
        symlink(`../../${pkg.bin}`, `${deep_dir}/node_modules/.bin/${dep.name}`)
        chmod(`${dep_store}/${pkg.bin}`, 0o755) // fix permissions. required for patchShebangs in nixos
      }
      else if (typeof pkg.bin == 'object') {
        for (const binName of Object.keys(pkg.bin)) {
          // TODO resolve realpath for link target
          // pkg.bin[binName] can be ./cli.js -> should be only cli.js
          symlink(`${dep_store_rel}/${pkg.bin[binName]}`, `node_modules/.bin/${binName}`); // TODO handle collisions
          symlink(`../../${pkg.bin[binName]}`, `${deep_dir}/node_modules/.bin/${binName}`); // TODO handle collisions
          chmod(`${dep_store}/${pkg.bin[binName]}`, 0o755) // fix permissions. required for patchShebangs in nixos
        }
      }
    }

    recurse();

    // run lifecycle scripts for dependency
    // run scripts after recurse, so that child-dependencies are installed
    if (doneScripts.has(`${dep.name}@${dep.version}`)) {
      console.log(`already done scripts: ${dep.name}@${dep.version}`);
    }
    else {
      const pkg = json(`${dep_store}/package.json`);
      if (pkg.scripts) {
        for (const script of ['preinstall', 'install', 'postinstall']) {
          if (!(script in pkg.scripts)) continue;
          spawn(['npm', 'run', script], { cwd: dep_store });
          // quick n dirty. we use npm to resolve binary paths. we could use require.resolve
        }
      }
      doneScripts.add(`${dep.name}@${dep.version}`);
    }
  })
}

npm_install_mini();
