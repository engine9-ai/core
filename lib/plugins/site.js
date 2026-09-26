/*
  The plugin registry a Cloudflare Worker is built with.

  `e9core setup` aliases `@engine9/core/plugins/site` in wrangler config to the
  site's ./engine9.plugins.js and puts `e9core build-plugins` in wrangler's
  build step, so the module is regenerated on every `wrangler dev` / `deploy`
  from package.json "engine9.pluginPackages".

  Without that alias there is no registry: the Worker starts, and the first
  plugin use fails with PLUGIN_CONFIG_INVALID telling you to run e9core setup.
*/
export default null;
