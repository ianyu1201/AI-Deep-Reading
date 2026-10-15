// Packaged entry point: no global Node/Python or developer path is required.
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const resources = process.resourcesPath;
process.env.AI_READING_CODEX = path.join(resources, 'runtime', 'codex', 'bin', 'codex');
process.env.AI_READING_NODE = path.join(resources, 'runtimes', 'node', 'bin', 'node');
process.env.AI_READING_PYTHON = path.join(resources, 'runtimes', 'python', 'bin', 'python3');
process.env.PYTHONDONTWRITEBYTECODE = '1';
// Prevent developer fixture switches from changing a installed application's library.
delete process.env.AI_READING_TEST_FIXTURES;
delete process.env.AI_READING_TEST;
import(pathToFileURL(path.join(__dirname, '../electron/main.mjs')).href);
