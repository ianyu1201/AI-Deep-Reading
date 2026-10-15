import { writeFile } from 'node:fs/promises';

export const name = 'ai-reading-runtime-readiness';
export const inject = ['skills', 'sessionQuery', 'sessionProjections', 'systemPrompt', 'agents', 'webServer', 'readingSessionsReady', 'desktopBusinessReady'];
export async function apply(ctx) {
  const methods = ['listSessions', 'readSession', 'listEvents', 'readSurface', 'traceEvent'];
  if (!methods.every(key => typeof ctx.sessionQuery[key] === 'function')) throw new Error('Required Harness history methods unavailable');
  await writeFile(process.env.AI_READING_READY_FILE, JSON.stringify({ pid: process.pid, port: ctx.webServer.port }));
}
