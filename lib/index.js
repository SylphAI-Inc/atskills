'use strict';
// atskills — the @skills protocol as a library.
// Everything the CLI does is here, importable: resolve, save, autotrigger,
// prompt building, the validating cache. An agent or app that wants deeper
// integration than shelling out embeds this instead.

module.exports = {
  ...require('./ids'),
  ...require('./fsx'),
  ...require('./cache'),
  sources: require('./sources'),
  resolve: require('./resolve').resolve,
  autotrigger: require('./autotrigger'),
  buildPrompt: require('./prompt').buildPrompt,
  save: require('./save').save,
  readSource: require('./save').readSource,
  ui: require('./ui'),
};
