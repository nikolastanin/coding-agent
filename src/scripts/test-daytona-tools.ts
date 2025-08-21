/*
  End-to-end test runner for Daytona-backed tools (without using the agent).
  - Requires DAYTONA_API_KEY in env.
  - Run with: npx tsx src/scripts/test-daytona-tools.ts
*/

import {
  createProject,
  getCurrentProject,
  setProjectId,
  writeFile,
  readFile,
  writeFiles,
  listFiles,
  createDirectory,
  checkFileExists,
  getFileInfo,
  getFileSize,
  runCommand,
  runCode,
  deleteFile,
  watchDirectory,
  servePreview,
} from '../mastra/tools/daytona-tools';

type Tool<TIn, TOut> = {
  id: string;
  execute: (args: { context: TIn }) => Promise<TOut>;
};

async function run() {
  if (!process.env.DAYTONA_API_KEY) {
    console.error('Missing DAYTONA_API_KEY environment variable.');
    process.exit(1);
  }

  const log = (label: string, data: unknown) => {
    // Keep output compact but readable
    console.log(`\n=== ${label} ===`);
    console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  };

  try {
    // 1) create project (Daytona sandbox)
    const created = await (createProject as unknown as Tool<any, any>).execute({ context: { metadata: { test: 'daytona-tools' } } });
    if ('error' in created) throw new Error(created.error);
    const projectId: string = created.projectId;
    log('createProject', created);

    // 2) setProjectId (explicit)
    const setId = await (setProjectId as unknown as Tool<any, any>).execute({ context: { projectId } });
    if ('error' in setId) throw new Error(setId.error);
    log('setProjectId', setId);

    // 2a) env diagnostics in /workspace
    const diagPwd = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'pwd', workingDirectory: '/workspace' } });
    log('diag:pwd', diagPwd);
    const diagNode = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'node -v || true', workingDirectory: '/workspace' } });
    log('diag:node -v', diagNode);
    const diagNpm = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'npm -v || true', workingDirectory: '/workspace' } });
    log('diag:npm -v', diagNpm);
    const diagWhichNpm = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'which npm || command -v npm || echo "npm not found"', workingDirectory: '/workspace' } });
    log('diag:which npm', diagWhichNpm);
    const diagLs = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'ls -la', workingDirectory: '/workspace' } });
    log('diag:ls -la', diagLs);

    // 2b) start dev server via servePreview (also installs dependencies)
    const previewEarly = await (servePreview as unknown as Tool<any, any>).execute({ context: { port: 8080 } });
    if ('error' in previewEarly) throw new Error(previewEarly.error);
    log('servePreview (early)', previewEarly);
    // Show recent dev server logs
    const devLogEarly = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'tail -n 50 dev-server.log || echo "no dev-server.log"', workingDirectory: '/workspace' } });
    log('dev-server.log (tail, early)', devLogEarly);

    // 2b) verify git repo initialized
    const gitInside = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'git rev-parse --is-inside-work-tree', workingDirectory: '/workspace' } });
    if ('error' in gitInside) throw new Error(gitInside.error);
    log('git:inside-work-tree', gitInside);

    const gitLast = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'git log -1 --pretty=%B || echo no-commit', workingDirectory: '/workspace' } });
    if ('error' in gitLast) throw new Error(gitLast.error);
    log('git:last-commit-message', gitLast);

    // 3) getCurrentProject
    const current = await (getCurrentProject as unknown as Tool<any, any>).execute({ context: {} });
    if ('error' in current) throw new Error(current.error);
    log('getCurrentProject', current);

    // 4) writeFile
    const writeOne = await (writeFile as unknown as Tool<any, any>).execute({ context: { path: 'hello/test.txt', content: 'Hello Daytona!' } });
    if ('error' in writeOne) throw new Error(writeOne.error);
    log('writeFile', writeOne);

    // 5) writeFiles
    const writeMany = await (writeFiles as unknown as Tool<any, any>).execute({ context: { files: [
      { path: 'hello/one.txt', data: 'One' },
      { path: 'hello/two.txt', data: 'Two' },
    ] } });
    if ('error' in writeMany) throw new Error(writeMany.error);
    log('writeFiles', writeMany);

    // 6) readFile
    const read = await (readFile as unknown as Tool<any, any>).execute({ context: { path: 'hello/test.txt' } });
    if ('error' in read) throw new Error(read.error);
    log('readFile', { path: 'hello/test.txt', executionPath: read.executionPath, contentSample: String(read.content).slice(0, 64) });

    // 7) listFiles
    const list = await (listFiles as unknown as Tool<any, any>).execute({ context: { path: 'hello' } });
    if ('error' in list) throw new Error(list.error);
    log('listFiles', list);

    // 8) createDirectory
    const mkd = await (createDirectory as unknown as Tool<any, any>).execute({ context: { path: 'tmp/test-dir' } });
    if ('error' in mkd) throw new Error(mkd.error);
    log('createDirectory', mkd);

    // 9) checkFileExists
    const exists = await (checkFileExists as unknown as Tool<any, any>).execute({ context: { path: 'tmp/test-dir' } });
    if ('error' in exists) throw new Error(exists.error);
    log('checkFileExists', exists);

    // 10) getFileInfo
    const info = await (getFileInfo as unknown as Tool<any, any>).execute({ context: { path: 'package.json' } });
    if ('error' in info) throw new Error(info.error);
    log('getFileInfo', info);

    // 11) getFileSize
    const size = await (getFileSize as unknown as Tool<any, any>).execute({ context: { path: 'package.json', humanReadable: true } });
    if ('error' in size) throw new Error(size.error);
    log('getFileSize', size);

    // 12) runCommand
    const cmd = await (runCommand as unknown as Tool<any, any>).execute({ context: { command: 'echo daytona-tools-ok', workingDirectory: '/workspace' } });
    if ('error' in cmd) throw new Error(cmd.error);
    log('runCommand', cmd);

    // 13) runCode
    const code = await (runCode as unknown as Tool<any, any>).execute({ context: { code: 'print("Hello from Daytona code runner")' } });
    if ('error' in code) throw new Error(code.error);
    log('runCode', code);

    // 14) watchDirectory (short)
    const watch = await (watchDirectory as unknown as Tool<any, any>).execute({ context: { path: '/workspace/hello', watchDuration: 1500 } });
    if ('error' in watch) throw new Error(watch.error);
    log('watchDirectory', watch);

    // 15) deleteFile (cleanup a file and dir)
    const del1 = await (deleteFile as unknown as Tool<any, any>).execute({ context: { path: 'hello/test.txt' } });
    if ('error' in del1) throw new Error(del1.error);
    const del2 = await (deleteFile as unknown as Tool<any, any>).execute({ context: { path: 'tmp/test-dir' } });
    if ('error' in del2) throw new Error(del2.error);
    log('deleteFile', { del1, del2 });

    // 16) servePreview already called earlier; preview URL was returned above

    console.log('\nAll Daytona tools executed successfully.');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

run();


