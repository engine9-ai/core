/**
 * Questions the setup wizard asks. Agents ask these same questions, in this
 * order, and pass the answers to `runSetupStep` (`npx e9core setup --step …`).
 * Do not add a second questionnaire.
 *
 * AGENTS.md lists these prompts. If you change a prompt here, change it there.
 */

export const SETUP_STEPS = [
  {
    id: 'choose',
    prompt: 'Where will the production site run?',
    choices: [
      {
        id: 'cloudflare',
        label: 'Cloudflare',
        detail: 'Production on Cloudflare. Development stays on this machine.'
      },
      {
        id: 'node',
        label: 'Your own servers',
        detail: 'Production on Node.js servers you run. Development stays on this machine.'
      }
    ]
  },
  {
    id: 'whoami',
    prompt: 'Which Cloudflare account is logged in on this development machine?',
    when: 'cloudflare'
  },
  {
    id: 'login',
    prompt: 'Log in to Cloudflare on this development machine?',
    when: 'cloudflare'
  },
  {
    id: 'setup-cloudflare',
    prompt: 'Create the local Cloudflare project? This does not deploy production.',
    when: 'cloudflare'
  },
  {
    id: 'setup-node',
    prompt: 'Create the local development database? This does not deploy production.',
    when: 'node'
  },
  {
    id: 'preview',
    prompt: 'Start a local Cloudflare preview on this development machine?',
    when: 'cloudflare'
  },
  {
    id: 'deploy',
    prompt: 'Deploy the production site to Cloudflare? Optional hostname.',
    when: 'cloudflare'
  },
  {
    id: 'write-config',
    prompt: 'Write engine9-config.js for local development?'
  },
  {
    id: 'try-signup',
    prompt: 'Save a test person on the local development site? Need an email and a name.'
  },
  {
    id: 'origins',
    prompt: 'Independent hosts only: which origins may call the API? Include the local preview and the production site.',
    advanced: true
  },
  {
    id: 'rotate-public',
    prompt: 'Replace the public key?',
    advanced: true
  },
  {
    id: 'finish',
    prompt: 'Finish setup and close the wizard on this development machine?'
  }
];

export function setupStep(id) {
  return SETUP_STEPS.find((step) => step.id === id) || null;
}
