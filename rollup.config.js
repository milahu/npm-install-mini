/*
  "devDependencies": {
    "@rollup/plugin-commonjs": "^25.0.3",
    "@rollup/plugin-json": "^6.0.0",
    "@rollup/plugin-node-resolve": "^15.1.0",
    "@rollup/plugin-terser": "^0.4.3",
    "rollup": "^3.28.0"
  }
*/

// rollup.config.js
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';
import terser from '@rollup/plugin-terser';

export default {
  input: 'src/index.js',
  output: {
    file: 'dist/index.js',
    format: 'cjs'
  },
  plugins: [
    resolve({
      preferBuiltins: true,
    }),
    commonjs(),
    json(),
    terser(), // minify
  ],
};
