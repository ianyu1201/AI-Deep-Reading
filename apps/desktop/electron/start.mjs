import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const child = spawn(electron, [fileURLToPath(new URL('../', import.meta.url)), ...process.argv.slice(2)], {
  env: { ...process.env, AI_READING_NODE: process.execPath },
  stdio: 'inherit',
});
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
