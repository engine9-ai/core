/*
  Loaded with `node --import` before every test file: core's workers use the
  Node plugin registry for this checkout, which is every @engine9/interfaces
  plugin (core's package.json declares no "engine9" config).
*/
import { ensureNodePluginRegistry } from '../bin/nodePluginRegistry.js';

ensureNodePluginRegistry({ cwd: new URL('..', import.meta.url).pathname });
