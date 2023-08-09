/*
  "devDependencies": {
    "webpack": "^5.88.2",
    "webpack-cli": "^5.1.4"
  }
*/

module.exports = {
  target: "node",
  experiments: {
  },
  output: {
    libraryTarget: 'commonjs', filename: 'index.js',
  },
  resolve: {
    extensions: [".js"],
  },
};

