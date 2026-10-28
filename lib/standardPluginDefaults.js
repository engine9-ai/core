/*
  Plugins that install from these definitions instead of the plugin registry.
*/
export const STANDARD_PLUGIN_DEFAULTS = {
  '@engine9/schemas/person_custom': {
    metadata: { prefix: 'person_custom', name: 'Custom Fields', unique: false, inbound: { upsert: ['upsertPersonCustom'] } }
  },
  '@engine9-testing/sql-plugin-timeline': { metadata: { prefix: 'testing_timeline', name: 'Testing Timeline' } }
};
