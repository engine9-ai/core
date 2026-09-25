/*
  The plugin registry this site is built with. Defaults to every interface in
  @engine9/interfaces. A site narrows or extends it by running
  `npx e9core build-plugins` and aliasing `@engine9/core/plugins/site` to the
  generated ./engine9.plugins.js (e9core setup adds that alias to wrangler).
*/
export { default } from './interfaces.js';
