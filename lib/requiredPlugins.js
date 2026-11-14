/*
  The required plugins: what every engine9 database has, whatever else it
  installs. Core reads and writes their tables itself, so it cannot run
  without them.

    @engine9/schemas/plugin       plugin and setting: every install records itself here
    @engine9/schemas/person       person, and the first step of the people pipeline
    @engine9/schemas/segment      segment and person_segment: admins and site roles
    @engine9/schemas/source_code  source_code_dictionary: the pipeline adds source_code_id

  Keep the list slim. A plugin that stores contact details (person_name,
  person_email, and the like) is never required, because a PII-free
  account cannot install it. Everything else is the site's choice, installed
  with `e9core install --plugin <path>`, often a plugin that includes others.

  PluginWorker.installRequiredPlugins installs them; e9core setup calls it.
  e9core upgrade installs any that are missing, so a release can add one.
  build-plugins always bundles them.
*/

export const REQUIRED_PLUGINS = Object.freeze([
  '@engine9/schemas/plugin',
  '@engine9/schemas/person',
  '@engine9/schemas/segment',
  '@engine9/schemas/source_code'
]);
