#!/usr/bin/env node

const documentModel = require('../models/document.js');

function printUsage() {
  console.log(`
Zettelrobbe MFA reset CLI

Usage:
  node scripts/mfa-reset.js --list
  node scripts/mfa-reset.js --user <username> [--yes]
  node scripts/mfa-reset.js --all --yes

Examples:
  node scripts/mfa-reset.js --list
  node scripts/mfa-reset.js --user admin --yes
  npm run mfa:reset -- --user admin --yes

Options:
  --list           List all users and MFA status.
  --user <name>    Reset MFA for one user.
  --all            Reset MFA for all users.
  --yes            Skip safety confirmation requirement.
  -h, --help       Show this help message.
`);
}

function parseArgs(argv) {
  const args = {
    list: false,
    all: false,
    user: null,
    yes: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--list') {
      args.list = true;
      continue;
    }

    if (token === '--all') {
      args.all = true;
      continue;
    }

    if (token === '--yes') {
      args.yes = true;
      continue;
    }

    if (token === '-h' || token === '--help') {
      args.help = true;
      continue;
    }

    if (token === '--user') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        throw new Error('Missing value for --user');
      }
      args.user = next;
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function isMfaEnabled(user) {
  const enabled = user && (user.mfa_enabled === 1 || user.mfa_enabled === true || user.mfa_enabled === '1');
  return Boolean(enabled && user.mfa_secret);
}

async function listUsers() {
  const users = await documentModel.getUsers();
  if (!Array.isArray(users) || users.length === 0) {
    console.log('No users found in the local database.');
    return;
  }

  console.log('Users:');
  users.forEach((user) => {
    const status = isMfaEnabled(user) ? 'enabled' : 'disabled';
    console.log(`- ${user.username}: MFA ${status}`);
  });
}

async function resetSingleUser(username) {
  const user = await documentModel.getUser(username);
  if (!user) {
    throw new Error(`User not found: ${username}`);
  }

  const changed = await documentModel.setUserMfaSettings(username, false, null);
  if (!changed) {
    throw new Error(`Failed to reset MFA for user: ${username}`);
  }

  console.log(`MFA reset successful for user: ${username}`);
}

async function resetAllUsers() {
  const users = await documentModel.getUsers();
  if (!Array.isArray(users) || users.length === 0) {
    console.log('No users found in the local database.');
    return;
  }

  let successCount = 0;
  for (const user of users) {
    const changed = await documentModel.setUserMfaSettings(user.username, false, null);
    if (changed) {
      successCount += 1;
      console.log(`Reset MFA for: ${user.username}`);
    }
  }

  if (successCount === 0) {
    throw new Error('No MFA reset operation succeeded.');
  }

  console.log(`MFA reset completed for ${successCount} user(s).`);
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
      printUsage();
      return;
    }

    if (args.list) {
      await listUsers();
      return;
    }

    if (args.all && args.user) {
      throw new Error('Use either --all or --user, not both.');
    }

    if (!args.all && !args.user) {
      throw new Error('No action selected. Use --list, --user <name>, or --all.');
    }

    if ((args.all || args.user) && !args.yes) {
      throw new Error('Refusing to modify MFA settings without --yes.');
    }

    if (args.all) {
      await resetAllUsers();
      return;
    }

    await resetSingleUser(args.user);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    printUsage();
    process.exit(1);
  }
}

main();
