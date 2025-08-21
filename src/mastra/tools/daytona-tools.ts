import { createTool } from '@mastra/core/tools';
import z from 'zod';
import { Daytona } from '@daytonaio/sdk';

// Daytona client singleton
let cachedDaytonaClient: Daytona | null = null;
function getDaytonaClient(): Daytona {
    if (cachedDaytonaClient) return cachedDaytonaClient;
    const apiKey = process.env.DAYTONA_API_KEY;
    if (!apiKey) {
        throw new Error('DAYTONA_API_KEY is not set. Please set it in your environment to use Daytona tools.');
    }
    cachedDaytonaClient = new Daytona({ apiKey });
    return cachedDaytonaClient;
}

// Global state manager for current Daytona sandbox (treated as project)
class ProjectStateManager {
    private static instance: ProjectStateManager;
    private currentProjectId: string | null = null;

    private constructor() {}

    public static getInstance(): ProjectStateManager {
        if (!ProjectStateManager.instance) {
            ProjectStateManager.instance = new ProjectStateManager();
        }
        return ProjectStateManager.instance;
    }

    public setProjectId(projectId: string): void {
        this.currentProjectId = projectId;
    }

    public getProjectId(): string | null {
        return this.currentProjectId;
    }

    public hasProjectId(): boolean {
        return this.currentProjectId !== null;
    }
}

const projectState = ProjectStateManager.getInstance();

// Rate limiting to avoid hammering APIs
const RATE_LIMIT_DELAY = 1500; // 1.5 seconds
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const withRateLimit = async <T>(fn: () => Promise<T>): Promise<T> => {
    await delay(RATE_LIMIT_DELAY);
    return fn();
};

// Helpers
function getErrorMessage(e: unknown): string {
    if (e instanceof Error) return e.message;
    try { return JSON.stringify(e); } catch { return String(e); }
}
function requireCurrentProjectId(provided?: string): string {
    const id = provided || projectState.getProjectId();
    if (!id) throw new Error('No project ID available. Please create a project first using createProject.');
    return id;
}

function normalizePath(inputPath: string | undefined): string {
    if (!inputPath || inputPath === './') return '/workspace';
    if (inputPath.startsWith('/')) return inputPath;
    const cleaned = inputPath.replace(/^\.\/?/, '');
    return `/workspace/${cleaned}`;
}

// Convert any given path to a pair: Daytona working directory (always 'workspace')
// and a path relative to that directory.
function toWorkspaceRelative(inputPath: string | undefined): { workingDir: string; relativePath: string } {
    const workingDir = 'workspace';
    if (!inputPath || inputPath === '.' || inputPath === './') return { workingDir, relativePath: '.' };
    if (inputPath.startsWith('/workspace/')) return { workingDir, relativePath: inputPath.replace('/workspace/', '') };
    if (inputPath === '/workspace') return { workingDir, relativePath: '.' };
    if (inputPath.startsWith('/')) return { workingDir, relativePath: inputPath }; // absolute path outside workspace
    const cleaned = inputPath.replace(/^\.\/?/, '');
    return { workingDir, relativePath: cleaned };
}

// Tools (IDs and shapes mirror e2b-local.ts)

export const createProject = createTool({
    id: 'createProject',
    description: 'Create a Daytona-backed project (provisions a sandbox and bootstraps repo)',
    inputSchema: z.object({
        metadata: z.record(z.string()).optional().describe('Custom metadata for the project (stored in .project file)'),
        envs: z.record(z.string()).optional().describe(`
      Custom environment variables for the project.
      Used when executing commands and code in the project.
      Can be overridden with the \`envs\` argument when executing commands or code.
    `),
        timeoutMS: z.number().optional().describe(`
      Timeout for operations in **milliseconds**.
      @default 300_000 // 5 minutes
    `),
    }),
    outputSchema: z
        .object({
            projectId: z.string(),
        })
        .or(
            z.object({
                error: z.string(),
            }),
        ),
    execute: async ({ context: projectOptions }) => {
        return withRateLimit(async () => {
            try {
                const daytona = getDaytonaClient();
                // Create Daytona sandbox with 30-minute auto-stop
                // Use Python so process.codeRun snippets (subprocess) work reliably
                const sandbox = await daytona.create({ language: 'python', autoStopInterval: 30 }); // docs: https://www.daytona.io/docs/sandbox-management/

                // Clone boilerplate directly into workspace to avoid subsequent moves
                // Prefer Daytona Git API for cloning per docs: https://www.daytona.io/docs/git-operations/
                await sandbox.git.clone(
                    'https://github.com/chihebnabil/lovable-boilerplate',
                    'workspace'
                );

                // Install dependencies (best-effort)
                const workspaceRoot = 'workspace';
                await sandbox.process.executeCommand('npm install', workspaceRoot, undefined, 1200);

                // Optionally write project metadata
                if (projectOptions.metadata || projectOptions.envs) {
                    const configB64 = Buffer.from(JSON.stringify({
                        metadata: projectOptions.metadata || {},
                        envs: projectOptions.envs || {},
                        createdAt: new Date().toISOString(),
                    }, null, 2), 'utf-8').toString('base64');
                    await sandbox.fs.uploadFile(Buffer.from(configB64, 'base64'), 'workspace/.project');
                }

                // Store in state and return
                projectState.setProjectId(sandbox.id);
                return { projectId: sandbox.id };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const runCode = createTool({
    id: 'runCode',
    description: 'Run code in the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId (Daytona sandbox id). If omitted, uses current project.'),
        code: z.string().describe('The code to run in the sandbox'),
        runCodeOpts: z
            .object({
                language: z.enum(['ts', 'js', 'python']).default('python').describe('Preferred language context'),
                envs: z.record(z.string()).optional().describe('Custom environment variables'),
                timeoutMS: z.number().optional().describe('Execution timeout in ms'),
                requestTimeoutMs: z.number().optional().describe('Request timeout in ms'),
            })
            .optional(),
    }),
    outputSchema: z
        .object({
            execution: z.string().describe('Serialized representation of the execution results'),
        })
        .or(z.object({ error: z.string().describe('The error from a failed execution') })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                // docs: https://www.daytona.io/docs/process-code-execution/
                const execution = await sandbox.process.codeRun(context.code);
                return { execution: JSON.stringify(execution), executionPath: '/workspace' };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const readFile = createTool({
    id: 'readFile',
    description: 'Read a file from the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        path: z.string().describe('Path to file to read (relative to /workspace or absolute)'),
    }),
    outputSchema: z
        .object({ content: z.string(), path: z.string(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const filePath = normalizePath(context.path);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const buf = await sandbox.fs.downloadFile(target);
                const content = (buf as Buffer).toString('utf-8');
                return { content, path: context.path, executionPath: filePath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const writeFile = createTool({
    id: 'writeFile',
    description: 'Write a single file to the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        path: z.string(),
        content: z.string(),
    }),
    outputSchema: z
        .object({ success: z.boolean(), path: z.string(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const filePath = normalizePath(context.path);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const parent = target.split('/').slice(0, -1).join('/') || workingDir;
                await sandbox.fs.createFolder(parent, '755');
                await sandbox.fs.uploadFile(Buffer.from(context.content, 'utf-8'), target);
                return { success: true, path: context.path, executionPath: filePath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const writeFiles = createTool({
    id: 'writeFiles',
    description: 'Write multiple files to the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        files: z.array(z.object({ path: z.string(), data: z.string() })),
    }),
    outputSchema: z
        .object({ success: z.boolean(), filesWritten: z.array(z.string()), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);

                const workingDir = 'workspace';
                // Ensure all parent directories exist
                const parents = new Set<string>();
                for (const f of context.files) {
                    const { relativePath } = toWorkspaceRelative(f.path);
                    const target = `${workingDir}/${relativePath}`;
                    const parent = target.split('/').slice(0, -1).join('/') || workingDir;
                    parents.add(parent);
                }
                for (const p of parents) {
                    await sandbox.fs.createFolder(p, '755');
                }

                await sandbox.fs.uploadFiles(
                    context.files.map(f => {
                        const { relativePath } = toWorkspaceRelative(f.path);
                        const target = `${workingDir}/${relativePath}`;
                        return { source: Buffer.from(f.data, 'utf-8'), destination: target } as any;
                    })
                );
                return { success: true, filesWritten: context.files.map(f => f.path), executionPath: '/workspace' };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const setProjectId = createTool({
    id: 'setProjectId',
    description: 'Set the current project ID (maps to Daytona sandbox id)',
    inputSchema: z.object({ projectId: z.string() }),
    outputSchema: z
        .object({ success: z.boolean(), projectId: z.string() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const daytona = getDaytonaClient();
                await daytona.get(context.projectId); // validate exists
                projectState.setProjectId(context.projectId);
                return { success: true, projectId: context.projectId };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const getCurrentProject = createTool({
    id: 'getCurrentProject',
    description: 'Get info about the current Daytona-backed project',
    inputSchema: z.object({}),
    outputSchema: z
        .object({ projectId: z.string() })
        .or(z.object({ error: z.string() })),
    execute: async () => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId();
                return { projectId };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const listFiles = createTool({
    id: 'listFiles',
    description: 'List files and directories in the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        path: z.string().default('./'),
    }),
    outputSchema: z
        .object({
            files: z.array(z.object({ name: z.string(), path: z.string(), isDirectory: z.boolean() })),
            path: z.string(),
            executionPath: z.string().optional(),
        })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const files = await sandbox.fs.listFiles(target);
                const absPath = normalizePath(context.path);
                const mapped = files.map(f => ({ name: f.name, path: `${absPath}/${f.name}`.replace(/\/$/, ''), isDirectory: !!f.isDir }));
                return { files: mapped, path: context.path, executionPath: absPath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const deleteFile = createTool({
    id: 'deleteFile',
    description: 'Delete a file or directory in the Daytona project sandbox',
    inputSchema: z.object({ projectId: z.string().optional(), path: z.string() }),
    outputSchema: z
        .object({ success: z.boolean(), path: z.string(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;

                // Check if directory
                try {
                    const details = await sandbox.fs.getFileDetails(target);
                    if (details.isDir) {
                        const pathForCmd = relativePath.startsWith('/') ? relativePath : relativePath;
                        const escaped = pathForCmd.replace(/'/g, "'\\''");
                        await sandbox.process.executeCommand(`sh -c "rm -rf '${escaped}'"`, workingDir);
                    } else {
                        await sandbox.fs.deleteFile(target);
                    }
                } catch {
                    // If details lookup fails, try deleteFile and ignore errors
                    await sandbox.fs.deleteFile(target).catch(() => {});
                }

                const targetPath = normalizePath(context.path);
                return { success: true, path: context.path, executionPath: targetPath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const createDirectory = createTool({
    id: 'createDirectory',
    description: 'Create a directory in the Daytona project sandbox',
    inputSchema: z.object({ projectId: z.string().optional(), path: z.string() }),
    outputSchema: z
        .object({ success: z.boolean(), path: z.string(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                await sandbox.fs.createFolder(target, '755');
                const dirPath = normalizePath(context.path);
                return { success: true, path: context.path, executionPath: dirPath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const getFileInfo = createTool({
    id: 'getFileInfo',
    description: 'Get metadata for a file or directory in the Daytona project sandbox',
    inputSchema: z.object({ projectId: z.string().optional(), path: z.string() }),
    outputSchema: z
        .object({
            name: z.string(),
            type: z.enum(['file','directory']).optional(),
            path: z.string(),
            size: z.number(),
            mode: z.number(),
            permissions: z.string(),
            owner: z.string(),
            group: z.string(),
            modifiedTime: z.date().optional(),
            symlinkTarget: z.string().optional(),
            executionPath: z.string().optional(),
        })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const details = await sandbox.fs.getFileDetails(target);
                const filePath = normalizePath(context.path);
                const modeValue = typeof details.mode === 'number' ? details.mode : (typeof details.mode === 'string' ? parseInt(details.mode as unknown as string, 8) || 0 : 0);
                return {
                    name: (details as any).name || target.split('/').pop() || target,
                    type: details.isDir ? 'directory' as const : 'file' as const,
                    path: filePath,
                    size: (details as any).size || 0,
                    mode: modeValue,
                    permissions: (details as any).permissions || '',
                    owner: 'unknown',
                    group: 'unknown',
                    modifiedTime: undefined,
                    symlinkTarget: undefined,
                    executionPath: filePath,
                };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const checkFileExists = createTool({
    id: 'checkFileExists',
    description: 'Check if a path exists in the Daytona project sandbox',
    inputSchema: z.object({ projectId: z.string().optional(), path: z.string() }),
    outputSchema: z
        .object({ exists: z.boolean(), path: z.string(), type: z.enum(['file','directory']).optional(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const filePath = normalizePath(context.path);
                try {
                    const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                    const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                    const details = await sandbox.fs.getFileDetails(target);
                    return { exists: true, path: context.path, type: details.isDir ? 'directory' : 'file', executionPath: filePath };
                } catch {
                    return { exists: false, path: context.path, executionPath: filePath } as any;
                }
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const getFileSize = createTool({
    id: 'getFileSize',
    description: 'Get the size of a file or directory in the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        path: z.string(),
        humanReadable: z.boolean().default(false),
    }),
    outputSchema: z
        .object({ size: z.number(), humanReadableSize: z.string().optional(), path: z.string(), type: z.enum(['file','directory']).optional(), executionPath: z.string().optional() })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const details = await sandbox.fs.getFileDetails(target);
                const size = (details as any).size || 0;
                let humanReadableSize: string | undefined = undefined;
                if (context.humanReadable) {
                    const sizes = ['B','KB','MB','GB','TB'];
                    let i = 0;
                    if (size > 0) {
                        i = Math.min(sizes.length - 1, Math.floor(Math.log(size) / Math.log(1024)));
                    }
                    humanReadableSize = `${(size / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
                }
                const filePath = normalizePath(context.path);
                return { size, humanReadableSize, path: context.path, type: details.isDir ? 'directory' as const : 'file' as const, executionPath: filePath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const watchDirectory = createTool({
    id: 'watchDirectory',
    description: 'Watch a directory for changes in the Daytona project sandbox (polled)',
    inputSchema: z.object({
        projectId: z.string().optional(),
        path: z.string(),
        recursive: z.boolean().default(false),
        watchDuration: z.number().default(30000),
    }),
    outputSchema: z
        .object({
            watchStarted: z.boolean(),
            path: z.string(),
            events: z.array(z.object({ type: z.string(), name: z.string(), timestamp: z.string() })),
            executionPath: z.string().optional(),
        })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const { workingDir, relativePath } = toWorkspaceRelative(context.path);
                const target = relativePath === '.' ? workingDir : `${workingDir}/${relativePath}`;
                const snap = async () => {
                    const list = await sandbox.fs.listFiles(target);
                    return list.map(f => ({ name: f.name, mtime: (f.modTime ? new Date(f.modTime).getTime() : 0) }));
                };

                const initial = await snap();
                await delay(context.watchDuration);
                const final = await snap();

                const initialNames = new Set(initial.map(f => f.name));
                const finalNames = new Set(final.map(f => f.name));
                const events: Array<{ type: string; name: string; timestamp: string }> = [];

                for (const f of final) {
                    if (!initialNames.has(f.name)) {
                        events.push({ type: 'CREATE', name: f.name, timestamp: new Date().toISOString() });
                    }
                }
                for (const f of initial) {
                    if (!finalNames.has(f.name)) {
                        events.push({ type: 'DELETE', name: f.name, timestamp: new Date().toISOString() });
                    }
                }

                const dirPath = normalizePath(context.path);
                return { watchStarted: true, path: context.path, events, executionPath: dirPath };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});

export const runCommand = createTool({
    id: 'runCommand',
    description: 'Run a shell command in the Daytona project sandbox',
    inputSchema: z.object({
        projectId: z.string().optional(),
        command: z.string(),
        workingDirectory: z.string().optional().describe('Relative to /workspace'),
        timeoutMs: z.number().default(30000),
        captureOutput: z.boolean().default(true),
        envs: z.record(z.string()).optional().describe('Environment variables to set for the command'),
    }),
    outputSchema: z
        .object({
            success: z.boolean(),
            exitCode: z.number(),
            stdout: z.string(),
            stderr: z.string(),
            command: z.string(),
            executionTime: z.number(),
            workingDir: z.string(),
            executionPath: z.string().optional(),
        })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                // Follow SDK examples: prefer relative 'workspace' unless user provides an absolute path
                const workingDir = context.workingDirectory ? context.workingDirectory : 'workspace';
                const start = Date.now();
                const timeoutSec = Math.max(1, Math.ceil((context.timeoutMs ?? 30000) / 1000));
                const res = await sandbox.process.executeCommand(context.command, workingDir, context.envs, timeoutSec);
                const executionTime = Date.now() - start;
                const stdout = String(res.result ?? '');
                // SDK doesn’t expose exitCode; assume success if no exception
                return { success: true, exitCode: 0, stdout, stderr: '', command: context.command, executionTime, workingDir, executionPath: workingDir };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});



export const servePreview = createTool({
    id: 'servePreview',
    description: 'Run npm install, start npm run dev, and return the Daytona preview URL/token on port 8080',
    inputSchema: z.object({
        projectId: z.string().optional(),
        workingDirectory: z.string().optional().describe('Relative to /workspace'),
    }),
    outputSchema: z
        .object({
            success: z.boolean(),
            url: z.string(),
            token: z.string(),
            port: z.number(),
            pid: z.number().optional(),
            logPath: z.string().optional(),
            executionPath: z.string().optional(),
        })
        .or(z.object({ error: z.string() })),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = requireCurrentProjectId(context.projectId);
                const daytona = getDaytonaClient();
                const sandbox = await daytona.get(projectId);
                const port = 8080;

                // Resolve absolute working directory based on user root dir
                const rootDir = (await sandbox.getUserRootDir()) || '/workspace';
                const requestedDir = (context.workingDirectory || '').trim();
                let workingDirAbs: string;
                if (!requestedDir || requestedDir === '.' || requestedDir === './') {
                    workingDirAbs = rootDir; // default to sandbox root (typically /workspace)
                } else if (requestedDir.startsWith('/')) {
                    workingDirAbs = requestedDir;
                } else {
                    workingDirAbs = `${rootDir}/${requestedDir.replace(/^\.\/?/, '')}`;
                }
                const logPath = `${workingDirAbs}/.preview-${port}.log`;

                // Ensure working directory exists
                const escapedWorkingDirAbs = workingDirAbs.replace(/"/g, '\\"');
                await sandbox.process.executeCommand(`mkdir -p "${escapedWorkingDirAbs}"`, rootDir);

                // 1) Install dependencies using npm install
                await sandbox.process.executeCommand('npm install', `${rootDir}/workspace` , undefined, 300000);

                // 2) Start dev server in background using nohup, expose PORT
                const startCmd = `nohup npm run dev > dev-server.log 2>&1 & echo $!`;
                const started = await sandbox.process.executeCommand(startCmd, `${rootDir}/workspace`, undefined);
                const pid = parseInt(String(started.result || '').trim().split('\n').pop() || '', 10);

                // 2b) Give the server a moment to initialize, then probe readiness with curl
                await delay(8000);
                const healthCheckCmd = `curl -s -o /dev/null -w '%{http_code}' http://localhost:${port} || echo 'failed'`;
                let isRunning = false;
                for (let attempt = 0; attempt < 3; attempt++) {
                    const check = await sandbox.process.executeCommand(healthCheckCmd, workingDirAbs, undefined, 30);
                    const code = String(check.result || '').trim();
                    if (code === '200') {
                        isRunning = true;
                        break;
                    }
                    await delay(2000);
                }

                // 3) Return preview link for requested port
                const { url, token } = await sandbox.getPreviewLink(port);
                return {
                    success: true,
                    url,
                    token,
                    port,
                    pid: Number.isFinite(pid) ? pid : undefined,
                    logPath,
                    executionPath: workingDirAbs,
                };
            } catch (e) {
                return { error: getErrorMessage(e) };
            }
        });
    },
});
