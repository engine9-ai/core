/*
  Loaded with `node --import` before every test file: core's workers run the
  plugins in the build registry, and the test build is every interface.
*/
import { setDefaultPluginRegistry } from '../lib/pluginRegistry.js';
import interfacePlugins from '../lib/plugins/interfaces.js';

setDefaultPluginRegistry(interfacePlugins);
