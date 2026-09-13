import { mkdirSync, rmSync } from 'node:fs';

async function run(command: string[]) {
  const process = Bun.spawn(command, { stdout: 'inherit', stderr: 'inherit' });
  if (await process.exited) throw new Error(`Failed: ${command.join(' ')}`);
}
await run(['docker', 'compose', '-f', 'compose.verify.yml', 'up', '-d', '--wait']);
await run(['docker', 'compose', '-f', 'compose.verify.yml', 'exec', '-T', 'postgres', 'psql', '-U', 'tern', '-d', 'tern_verify', '-v', 'ON_ERROR_STOP=1', '-f', '/seed.sql']);
await run(['bun', 'run', 'build']);
mkdirSync('.e2e', { recursive: true });
for (const suffix of ['', '-wal', '-shm']) rmSync(`.e2e/app.sqlite${suffix}`, { force: true });
await run(['bun', 'x', 'playwright', 'test']);
