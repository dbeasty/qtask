// Monorepo Metro config: lets the Expo app import shared domain types/logic
// straight from ../shared/src (see docs/Mobile_Client_Plan.md, Phase 0).
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.extraNodeModules = {
  '@qtask/shared': path.resolve(workspaceRoot, 'shared/src'),
};

module.exports = config;
