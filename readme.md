# pnpm-install-only

Install node_modules from package.json + package-lock.json

## the pnpm install algorithm

1. build dependency tree from `package.json` and `package-lock.json`. this is handled by the [lockTree](src/lockTree.js) function from [npm/logical-tree](https://github.com/npm/logical-tree). the original `npm` would deduplicate "transitive" dependencies and build a flat node_modules, but here we build a deep node_modules with symlinks to a local store in `node_modues/.pnpm/`.
1. unpack dependencies to the local store `node_modues/.pnpm/`. the `*.tar.gz` files are provided by `npmlock2nix`. to unpack, we call `tar xf package.tar.gz`
1. symlink first-level dependencies from `node_modules/(name)` to `node_modues/.pnpm/(name)@(version)/node_modules/(name)`
1. symlink second-level dependencies from `node_modues/.pnpm/(name)@(version)/node_modules/(name)` to `node_modues/.pnpm/(parentName)@(parentVersion)/node_modules/(name)`
1. for each dependency, run the lifecycle scripts `preinstall` `install` `postinstall`. process the dependencies in depth-first order (last-level dependencies first, first-level dependencies last), so that child-dependencies are available.
1. when the root package has a `prepare` or `prepublish` script, also install its `devDependencies` (TODO verify)
1. for the root package, run the lifecycle scripts `preinstall` `install` `postinstall` `prepublish` `preprepare` `prepare` `postprepare`. docs: [lifecycle scripts](https://docs.npmjs.com/cli/v7/using-npm/scripts#life-cycle-scripts) (look for `npm install`)

<details>
<summary>details: lifecycle scripts</summary>

test file: `package/package.json`

```json
{
  "name": "test-lifecycle-scripts",
  "version": "1.0.0",
  "scripts": {
    "preinstall": "node -p \"require.resolve('test')\" >preinstall.txt",
    "install": "node -p \"require.resolve('test')\" >install.txt",
    "postinstall": "node -p \"require.resolve('test')\" >postinstall.txt",
    "prepublish": "echo hello >prepublish.txt",
    "preprepare": "echo hello >preprepare.txt",
    "prepare": "echo hello >prepare.txt",
    "postprepare": "echo hello >postprepare.txt"
  },
  "dependencies": {
    "test": "*"
  }
}
```

test file: `package.json`

```json
{
  "name": "test-project",
  "version": "1.0.0",
  "scripts": {
    "preinstall": "echo hello >preinstall.txt",
    "install": "echo hello >install.txt",
    "postinstall": "echo hello >postinstall.txt",
    "prepublish": "echo hello >prepublish.txt",
    "preprepare": "echo hello >preprepare.txt",
    "prepare": "echo hello >prepare.txt",
    "postprepare": "echo hello >postprepare.txt"
  },
  "dependencies": {
    "test-lifecycle-scripts": "file:package.tar.gz"
  }
}
```

```bash
# save package.json
mkdir package
# save package/package.json
rm package.tar.gz
tar czf package.tar.gz package
rm -rf node_modules
rm package-lock.json
npm init -y
npm i package.tar.gz
cat node_modules/*/*.txt
```

result

```
ls node_modules/*/*.txt -t -r | cat
node_modules/test-lifecycle-scripts/preinstall.txt
node_modules/test-lifecycle-scripts/install.txt
node_modules/test-lifecycle-scripts/postinstall.txt
```

```
cat node_modules/test-lifecycle-scripts/*.txt 
/tmp/test-project/node_modules/test/test.js
/tmp/test-project/node_modules/test/test.js
/tmp/test-project/node_modules/test/test.js
```

```
ls *.txt -t -r | cat
preinstall.txt
install.txt
postinstall.txt
prepublish.txt
preprepare.txt
prepare.txt
postprepare.txt
```
</details>

## npm ci

[why use npm ci](https://javascript.plainenglish.io/why-you-should-never-use-npm-install-in-your-ci-cd-pipelines-da0b89346d8d)

`npm ci` or "npm clean install" will
* delete any old node_modules
* only use locked dependencies from package-lock.json
* not modify package.json

## tests

todo

this program should produce the same result as `pnpm install`,
so testing can be as simple as

1. prepare a set of `package.json` and `package-lock.json` files.
these files must be valid, since this program will do no validation
1. run this script, move `node_modules` to `node_modules-actual`
1. run `pnpm import` (to produce a `pnpm-lock.yaml` file) and run `pnpm install`,
move `node_modules` to `node_modules-expected`
1. compare the two folders with `diff -r node_modules-actual node_modules-expected`

the only difference should be pnpm-internal files,
like `node_modules/.pnpm/lock.yaml`
(the [current lockfile](https://github.com/pnpm/pnpm/blob/8e76690f4dcd11d3ac263f565a684d71573ccfeb/packages/lockfile-file/src/write.ts#L142) of pnpm)

## non-standard behavior

> this program should produce the same result as `pnpm install`

except for obvious bugs in pnpm, like [pnpm does not install peerDependencies like npm v7](https://github.com/pnpm/pnpm/issues/827).
in this case, `npm` (the original nodejs package manager) defines the expected behavior

update: `pnpm` has [now implemented](https://github.com/pnpm/pnpm/discussions/3995#discussioncomment-1958472)
the option [auto-install-peers](https://pnpm.io/npmrc#auto-install-peers)

```
pnpm config set auto-install-peers true
```

but this is NOT satisfying,
because it has NO effect on `pnpm install`.
it only has an effect on `pnpm add some-package`

so currently, `pnpm` can NOT be used as a drop-in replacement for npmv7

(and thanks to the
[insane complexity](https://gist.github.com/amcdnl/b52e9dd11850eeb8de8f?permalink_comment_id=4056528#gistcomment-4056528)
of pnpm, its
[hard to add this feature](https://github.com/pnpm/pnpm/discussions/3995#discussioncomment-1893883))

workaround: add a pnpm hook

https://github.com/pnpm/pnpm/discussions/3995#discussioncomment-1647425

```js
// .pnpmfile.cjs

function readPackage(pkg) {
  pkg.dependencies = {
    ...pkg.peerDependencies,
    ...pkg.dependencies,
  }
  pkg.peerDependencies = {};

  return pkg;
}

module.exports = {
  hooks: {
    readPackage,
  },
};
```
