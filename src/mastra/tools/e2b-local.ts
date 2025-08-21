import { createTool } from '@mastra/core/tools';
import z from 'zod';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

// Global state manager for project ID
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

// Get the singleton instance
const projectState = ProjectStateManager.getInstance();

// Rate limiting delay to prevent OpenAI API rate limits
const RATE_LIMIT_DELAY = 1500; // 1.5 seconds between tool executions

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withRateLimit = async <T>(fn: () => Promise<T>): Promise<T> => {
  await delay(RATE_LIMIT_DELAY);
  return fn();
};

// Define local file types similar to E2B
enum LocalFileType {
    FILE = 'file',
    DIR = 'directory',
}

// Define local filesystem event types
enum LocalFilesystemEventType {
    CHANGE = 'change',
    RENAME = 'rename',
}

const PROJECTS_DIR = 'projects';

// Helper function to generate random project name
function generateProjectId(): string {
    const randomString = Math.random().toString(36).substring(2, 15);
    return `project_${randomString}`;
}

// Helper function to resolve project path
function getProjectPath(projectId: string): string {
    return path.join(process.cwd(), PROJECTS_DIR, projectId);
}

// Helper function to resolve file path within project
function resolveProjectFilePath(projectId: string, filePath: string): string {
    const projectPath = getProjectPath(projectId);
    // Remove leading slash if present and join with project path
    const cleanPath = filePath.startsWith('/') ? filePath.slice(1) : filePath;
    return path.join(projectPath, cleanPath);
}

// Helper function to get current projectId or throw error if none exists
function getCurrentProjectId(): string {
    const projectId = projectState.getProjectId();
    if (!projectId) {
        throw new Error('No project ID available. Please create a project first using createProject tool.');
    }
    return projectId;
}

export const createProject = createTool({
    id: 'createProject',
    description: 'Create a local project directory',
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
                return withRateLimit(async () => {
                    try {
                        const projectId = generateProjectId();
                        const projectPath = getProjectPath(projectId);

                        // Ensure projects directory exists
                        await fs.mkdir(PROJECTS_DIR, { recursive: true });

                // Create project directory
                await fs.mkdir(projectPath, { recursive: true });

                // Clone the lovable-boilerplate repository
                await new Promise<void>((resolve, reject) => {
                    const gitClone = spawn('git', ['clone', 'https://github.com/chihebnabil/lovable-boilerplate', '.'], {
                        cwd: projectPath,
                        stdio: 'inherit'
                    });

                    gitClone.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`Git clone failed with exit code ${code}`));
                        }
                    });

                    gitClone.on('error', (error) => {
                        reject(error);
                    });
                });

                // Run npm install to install dependencies
                await new Promise<void>((resolve, reject) => {
                    const npmInstall = spawn('npm', ['install'], {
                        cwd: projectPath,
                        stdio: 'inherit'
                    });

                    npmInstall.on('close', (code) => {
                        if (code === 0) {
                            resolve();
                        } else {
                            reject(new Error(`npm install failed with exit code ${code}`));
                        }
                    });

                    npmInstall.on('error', (error) => {
                        reject(error);
                    });
                });

                // Store project metadata if provided
                if (projectOptions.metadata || projectOptions.envs) {
                    const projectConfig = {
                        metadata: projectOptions.metadata || {},
                        envs: projectOptions.envs || {},
                        createdAt: new Date().toISOString(),
                    };
                    await fs.writeFile(
                        path.join(projectPath, '.project'),
                        JSON.stringify(projectConfig, null, 2)
                    );
                }

                        // Store the projectId in global state for other tools to use
                        projectState.setProjectId(projectId);
                        
                        return {
                            projectId: projectId,
                        };
                    } catch (e) {
                        return {
                            error: JSON.stringify(e),
                        };
                    }
                });
        });
    },
});

export const runCode = createTool({
    id: 'runCode',
    description: 'Run code in a local project directory',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to run the code (optional, will use current project if not provided)'),
        code: z.string().describe('The code to run in the project'),
        runCodeOpts: z
            .object({
                language: z
                    .enum(['ts', 'js', 'python'])
                    .default('python')
                    .describe('language used for code execution. If not provided, default python context is used'),
                envs: z.record(z.string()).optional().describe('Custom environment variables for code execution.'),
                timeoutMS: z.number().optional().describe(`
        Timeout for the code execution in **milliseconds**.
        @default 60_000 // 60 seconds
      `),
                requestTimeoutMs: z.number().optional().describe(`
        Timeout for the request in **milliseconds**.
        @default 30_000 // 30 seconds
      `),
            })
            .optional()
            .describe('Run code options'),
    }),
    outputSchema: z
        .object({
            execution: z.string().describe('Serialized representation of the execution results'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed execution'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
                return withRateLimit(async () => {
                    try {
                        // Use provided projectId or get from global state
                        const projectId = context.projectId || getCurrentProjectId();
                        const projectPath = getProjectPath(projectId);
                        const options = context.runCodeOpts || {};
                        const language = (options as any).language || 'python';
                        const envs = (options as any).envs || {};
                        const timeoutMS = (options as any).timeoutMS || 60000;

                // Create temporary file for code execution
                const tempFileName = `temp_${Date.now()}`;
                let tempFilePath: string;
                let command: string;
                let args: string[] = [];

                switch (language) {
                    case 'python':
                        tempFilePath = path.join(projectPath, `${tempFileName}.py`);
                        command = 'python';
                        args = [tempFilePath];
                        break;
                    case 'js':
                        tempFilePath = path.join(projectPath, `${tempFileName}.js`);
                        command = 'node';
                        args = [tempFilePath];
                        break;
                    case 'ts':
                        tempFilePath = path.join(projectPath, `${tempFileName}.ts`);
                        command = 'npx';
                        args = ['ts-node', tempFilePath];
                        break;
                    default:
                        tempFilePath = path.join(projectPath, `${tempFileName}.py`);
                        command = 'python';
                        args = [tempFilePath];
                }

                // Write code to temp file
                await fs.writeFile(tempFilePath, context.code);

                // Execute code
                const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
                    const child = spawn(command, args, {
                        cwd: projectPath,
                        env: { ...process.env, ...envs },
                        timeout: timeoutMS,
                    });

                    let stdout = '';
                    let stderr = '';

                    child.stdout?.on('data', (data) => {
                        stdout += data.toString();
                    });

                    child.stderr?.on('data', (data) => {
                        stderr += data.toString();
                    });

                    child.on('close', (code) => {
                        resolve({
                            stdout,
                            stderr,
                            exitCode: code || 0,
                        });
                    });

                    child.on('error', (error) => {
                        resolve({
                            stdout,
                            stderr: error.message,
                            exitCode: 1,
                        });
                    });
                });

                // Clean up temp file
                try {
                    await fs.unlink(tempFilePath);
                } catch (e) {
                    // Ignore cleanup errors
                }

                const execution = {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    exitCode: result.exitCode,
                    success: result.exitCode === 0,
                };

                return {
                    execution: JSON.stringify(execution),
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
                });
        });
    },
});

export const readFile = createTool({
    id: 'readFile',
    description: 'Read a file from the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to read the file from (optional, will use current project if not provided)'),
        path: z.string().describe('The path to the file to read'),
    }),
    outputSchema: z
        .object({
            content: z.string().describe('The content of the file'),
            path: z.string().describe('The path of the file that was read'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file read'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
                return withRateLimit(async () => {
                    try {
                        // Use provided projectId or get from global state
                        const projectId = context.projectId || getCurrentProjectId();
                        const filePath = resolveProjectFilePath(projectId, context.path);
                        const fileContent = await fs.readFile(filePath, 'utf-8');

                        return {
                            content: fileContent,
                            path: context.path,
                        };
                    } catch (e) {
                        return {
                            error: JSON.stringify(e),
                        };
                    }
                });
        });
    },
});

export const writeFile = createTool({
    id: 'writeFile',
    description: 'Write a single file to the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to write the file to (optional, will use current project if not provided)'),
        path: z.string().describe('The path where the file should be written'),
        content: z.string().describe('The content to write to the file'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the file was written successfully'),
            path: z.string().describe('The path where the file was written'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file write'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
                return withRateLimit(async () => {
                    try {
                        // Use provided projectId or get from global state
                        const projectId = context.projectId || getCurrentProjectId();
                        const filePath = resolveProjectFilePath(projectId, context.path);

                        // Ensure directory exists
                        const dir = path.dirname(filePath);
                        await fs.mkdir(dir, { recursive: true });

                        await fs.writeFile(filePath, context.content, 'utf-8');

                        return {
                            success: true,
                            path: context.path,
                        };
                    } catch (e) {
                        return {
                            error: JSON.stringify(e),
                        };
                    }
                });
        });
    },
});

export const writeFiles = createTool({
    id: 'writeFiles',
    description: 'Write multiple files to the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to write the files to (optional, will use current project if not provided)'),
        files: z
            .array(
                z.object({
                    path: z.string().describe('The path where the file should be written'),
                    data: z.string().describe('The content to write to the file'),
                }),
            )
            .describe('Array of files to write, each with path and data'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether all files were written successfully'),
            filesWritten: z.array(z.string()).describe('Array of file paths that were written'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed files write'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
                return withRateLimit(async () => {
                    try {
                        // Use provided projectId or get from global state
                        const projectId = context.projectId || getCurrentProjectId();
                        const filesWritten: string[] = [];

                        for (const file of context.files) {
                            const filePath = resolveProjectFilePath(projectId, file.path);

                            // Ensure directory exists
                            const dir = path.dirname(filePath);
                            await fs.mkdir(dir, { recursive: true });

                            await fs.writeFile(filePath, file.data, 'utf-8');
                            filesWritten.push(file.path);
                        }

                        return {
                            success: true,
                            filesWritten,
                        };
                    } catch (e) {
                        return {
                            error: JSON.stringify(e),
                        };
                    }
                });
        });
    },
});

export const setProjectId = createTool({
    id: 'setProjectId',
    description: 'Set the current project ID manually (useful when you know the projectId from a previous session)',
    inputSchema: z.object({
        projectId: z.string().describe('The project ID to set as current'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the project ID was set successfully'),
            projectId: z.string().describe('The project ID that was set'),
            projectPath: z.string().describe('The full path to the project'),
        })
        .or(
            z.object({
                error: z.string().describe('The error if setting the project ID failed'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const projectId = context.projectId;
                const projectPath = getProjectPath(projectId);
                
                // Verify the project directory exists
                try {
                    await fs.access(projectPath);
                } catch {
                    return {
                        error: `Project directory does not exist: ${projectPath}`,
                    };
                }
                
                // Set the project ID in global state
                projectState.setProjectId(projectId);
                
                return {
                    success: true,
                    projectId,
                    projectPath,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const getCurrentProject = createTool({
    id: 'getCurrentProject',
    description: 'Get information about the current project',
    inputSchema: z.object({}),
    outputSchema: z
        .object({
            projectId: z.string().describe('The current project ID'),
            projectPath: z.string().describe('The full path to the current project'),
        })
        .or(
            z.object({
                error: z.string().describe('The error if no project is currently active'),
            }),
        ),
    execute: async () => {
        return withRateLimit(async () => {
            try {
                const projectId = getCurrentProjectId();
                const projectPath = getProjectPath(projectId);
                
                return {
                    projectId,
                    projectPath,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const listFiles = createTool({
    id: 'listFiles',
    description: 'List files and directories in a path within the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to list files from (optional, will use current project if not provided)'),
        path: z.string().default('./').describe('The directory path to list files from'),
    }),
    outputSchema: z
        .object({
            files: z
                .array(
                    z.object({
                        name: z.string().describe('The name of the file or directory'),
                        path: z.string().describe('The full path of the file or directory'),
                        isDirectory: z.boolean().describe('Whether this is a directory'),
                    }),
                )
                .describe('Array of files and directories'),
            path: z.string().describe('The path that was listed'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file listing'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const dirPath = resolveProjectFilePath(projectId, context.path);
            const entries = await fs.readdir(dirPath, { withFileTypes: true });

            const files = entries.map(entry => ({
                name: entry.name,
                path: path.join(context.path, entry.name),
                isDirectory: entry.isDirectory(),
            }));

            return {
                files,
                path: context.path,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const deleteFile = createTool({
    id: 'deleteFile',
    description: 'Delete a file or directory from the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to delete the file from (optional, will use current project if not provided)'),
        path: z.string().describe('The path to the file or directory to delete'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the file was deleted successfully'),
            path: z.string().describe('The path that was deleted'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file deletion'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const filePath = resolveProjectFilePath(projectId, context.path);
            const stat = await fs.stat(filePath);

            if (stat.isDirectory()) {
                await fs.rmdir(filePath, { recursive: true });
            } else {
                await fs.unlink(filePath);
            }

            return {
                success: true,
                path: context.path,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const createDirectory = createTool({
    id: 'createDirectory',
    description: 'Create a directory in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to create the directory in (optional, will use current project if not provided)'),
        path: z.string().describe('The path where the directory should be created'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the directory was created successfully'),
            path: z.string().describe('The path where the directory was created'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed directory creation'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            
            // First validate that the projectId exists and is correct
            const projectPath = getProjectPath(projectId);
            
            try {
                // Check if the project directory exists
                await fs.access(projectPath);
            } catch {
                return {
                    error: `Project ID "${projectId}" is not correct or project does not exist. Please use a valid projectId.`,
                };
            }
            
            // If projectId is valid, proceed with directory creation
            const dirPath = resolveProjectFilePath(projectId, context.path);
            await fs.mkdir(dirPath, { recursive: true });

            return {
                success: true,
                path: context.path,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const getFileInfo = createTool({
    id: 'getFileInfo',
    description: 'Get detailed information about a file or directory in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to get file information from (optional, will use current project if not provided)'),
        path: z.string().describe('The path to the file or directory to get information about'),
    }),
    outputSchema: z
        .object({
            name: z.string().describe('The name of the file or directory'),
            type: z.nativeEnum(LocalFileType).optional().describe('Whether this is a file or directory'),
            path: z.string().describe('The full path of the file or directory'),
            size: z.number().describe('The size of the file or directory in bytes'),
            mode: z.number().describe('The file mode (permissions as octal number)'),
            permissions: z.string().describe('Human-readable permissions string'),
            owner: z.string().describe('The owner of the file or directory'),
            group: z.string().describe('The group of the file or directory'),
            modifiedTime: z.date().optional().describe('The last modified time in ISO string format'),
            symlinkTarget: z.string().optional().describe('The target path if this is a symlink, null otherwise'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file info request'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const filePath = resolveProjectFilePath(projectId, context.path);
            const stat = await fs.stat(filePath);
            const fileName = path.basename(filePath);

            // Convert mode to permissions string (simplified)
            const mode = stat.mode;
            const permissions = [
                mode & parseInt('400', 8) ? 'r' : '-',
                mode & parseInt('200', 8) ? 'w' : '-',
                mode & parseInt('100', 8) ? 'x' : '-',
                mode & parseInt('40', 8) ? 'r' : '-',
                mode & parseInt('20', 8) ? 'w' : '-',
                mode & parseInt('10', 8) ? 'x' : '-',
                mode & parseInt('4', 8) ? 'r' : '-',
                mode & parseInt('2', 8) ? 'w' : '-',
                mode & parseInt('1', 8) ? 'x' : '-',
            ].join('');

            let symlinkTarget: string | undefined;
            try {
                if (stat.isSymbolicLink()) {
                    symlinkTarget = await fs.readlink(filePath);
                }
            } catch (e) {
                // Not a symlink or can't read link
            }

            return {
                name: fileName,
                type: stat.isDirectory() ? LocalFileType.DIR : LocalFileType.FILE,
                path: context.path,
                size: stat.size,
                mode: mode,
                permissions: permissions,
                owner: stat.uid.toString(),
                group: stat.gid.toString(),
                modifiedTime: stat.mtime,
                symlinkTarget,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const checkFileExists = createTool({
    id: 'checkFileExists',
    description: 'Check if a file or directory exists in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to check file existence in (optional, will use current project if not provided)'),
        path: z.string().describe('The path to check for existence'),
    }),
    outputSchema: z
        .object({
            exists: z.boolean().describe('Whether the file or directory exists'),
            path: z.string().describe('The path that was checked'),
            type: z.nativeEnum(LocalFileType).optional().describe('The type if the path exists'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed existence check'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const filePath = resolveProjectFilePath(projectId, context.path);

            try {
                const stat = await fs.stat(filePath);
                return {
                    exists: true,
                    path: context.path,
                    type: stat.isDirectory() ? LocalFileType.DIR : LocalFileType.FILE,
                };
            } catch (e) {
                // If stat fails, the file doesn't exist
                return {
                    exists: false,
                    path: context.path,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const getFileSize = createTool({
    id: 'getFileSize',
    description: 'Get the size of a file or directory in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to get file size from (optional, will use current project if not provided)'),
        path: z.string().describe('The path to the file or directory'),
        humanReadable: z
            .boolean()
            .default(false)
            .describe("Whether to return size in human-readable format (e.g., '1.5 KB', '2.3 MB')"),
    }),
    outputSchema: z
        .object({
            size: z.number().describe('The size in bytes'),
            humanReadableSize: z.string().optional().describe('Human-readable size string if requested'),
            path: z.string().describe('The path that was checked'),
            type: z.nativeEnum(LocalFileType).optional().describe('Whether this is a file or directory'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed size check'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const filePath = resolveProjectFilePath(projectId, context.path);
            const stat = await fs.stat(filePath);

            let humanReadableSize: string | undefined;

            if (context.humanReadable) {
                const bytes = stat.size;
                const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
                if (bytes === 0) {
                    humanReadableSize = '0 B';
                } else {
                    const i = Math.floor(Math.log(bytes) / Math.log(1024));
                    const size = (bytes / Math.pow(1024, i)).toFixed(1);
                    humanReadableSize = `${size} ${sizes[i]}`;
                }
            }

            return {
                size: stat.size,
                humanReadableSize,
                path: context.path,
                type: stat.isDirectory() ? LocalFileType.DIR : LocalFileType.FILE,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const watchDirectory = createTool({
    id: 'watchDirectory',
    description: 'Start watching a directory for file system changes in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to watch directory in (optional, will use current project if not provided)'),
        path: z.string().describe('The directory path to watch for changes'),
        recursive: z.boolean().default(false).describe('Whether to watch subdirectories recursively'),
        watchDuration: z
            .number()
            .default(30000)
            .describe('How long to watch for changes in milliseconds (default 30 seconds)'),
    }),
    outputSchema: z
        .object({
            watchStarted: z.boolean().describe('Whether the watch was started successfully'),
            path: z.string().describe('The path that was watched'),
            events: z
                .array(
                    z.object({
                        type: z
                            .nativeEnum(LocalFilesystemEventType)
                            .describe('The type of filesystem event (change, rename)'),
                        name: z.string().describe('The name of the file that changed'),
                        timestamp: z.string().describe('When the event occurred'),
                    }),
                )
                .describe('Array of filesystem events that occurred during the watch period'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed directory watch'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const dirPath = resolveProjectFilePath(projectId, context.path);
            const events: Array<{ type: LocalFilesystemEventType; name: string; timestamp: string }> = [];

            // Start watching the directory
            const watcher = fsSync.watch(dirPath, { recursive: context.recursive }, (eventType, filename) => {
                if (filename) {
                    events.push({
                        type: eventType === 'change' ? LocalFilesystemEventType.CHANGE : LocalFilesystemEventType.RENAME,
                        name: filename,
                        timestamp: new Date().toISOString(),
                    });
                }
            });

            // Watch for the specified duration
            await new Promise(resolve => setTimeout(resolve, context.watchDuration));

            // Stop watching
            watcher.close();

            return {
                watchStarted: true,
                path: context.path,
                events,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});



export const runCommand = createTool({
    id: 'runCommand',
    description: 'Run a shell command in the local project',
    inputSchema: z.object({
        projectId: z.string().optional().describe('The projectId for the project to run the command in (optional, will use current project if not provided)'),
        command: z.string().describe('The shell command to execute'),
        workingDirectory: z.string().optional().describe('The working directory to run the command in (relative to project root)'),
        timeoutMs: z.number().default(30000).describe('Timeout for the command execution in milliseconds'),
        captureOutput: z.boolean().default(true).describe('Whether to capture stdout and stderr output'),
    }),
                outputSchema: z
        .object({
            success: z.boolean().describe('Whether the command executed successfully'),
            exitCode: z.number().describe('The exit code of the command'),
            stdout: z.string().describe('The standard output from the command'),
            stderr: z.string().describe('The standard error from the command'),
            command: z.string().describe('The command that was executed'),
            executionTime: z.number().describe('How long the command took to execute in milliseconds'),
            workingDir: z.string().describe('The working directory where the command was executed'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed command execution'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided projectId or get from global state
            const projectId = context.projectId || getCurrentProjectId();
            const projectPath = getProjectPath(projectId);
            let workingDir = context.workingDirectory 
                ? resolveProjectFilePath(projectId, context.workingDirectory)
                : projectPath;

            const startTime = Date.now();

            // For npm commands, automatically find the correct working directory if package.json is not in current workingDir
            if (context.command.startsWith('npm ') && !context.workingDirectory) {
                const packageJsonPath = path.join(workingDir, 'package.json');
                try {
                    await fs.access(packageJsonPath);
                } catch {
                    // package.json not found in current workingDir, search for it
                    const searchForPackageJson = async (dir: string): Promise<string | null> => {
                        try {
                            const entries = await fs.readdir(dir, { withFileTypes: true });
                            
                            for (const entry of entries) {
                                if (entry.name === 'package.json') {
                                    return dir;
                                }
                            }
                            
                            // Search subdirectories
                            for (const entry of entries) {
                                if (entry.isDirectory()) {
                                    const subDir = path.join(dir, entry.name);
                                    const result = await searchForPackageJson(subDir);
                                    if (result) return result;
                                }
                            }
                        } catch (e) {
                            // Directory not accessible, skip
                        }
                        
                        return null;
                    };

                    const foundDir = await searchForPackageJson(workingDir);
                    if (foundDir) {
                        // Update workingDir to where package.json was found
                        workingDir = foundDir;
                    } else {
                        return {
                            error: `package.json not found in project. Please ensure you're running npm commands from the correct directory.`,
                        };
                    }
                }
            }

            const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
                // For npm commands, use shell execution to handle them properly
                const child = spawn(context.command, [], {
                    cwd: workingDir,
                    timeout: context.timeoutMs,
                    shell: true,
                    stdio: context.captureOutput ? 'pipe' : 'inherit',
                });

                let stdout = '';
                let stderr = '';

                if (context.captureOutput) {
                    child.stdout?.on('data', (data) => {
                        stdout += data.toString();
                    });

                    child.stderr?.on('data', (data) => {
                        stderr += data.toString();
                    });
                }

                child.on('close', (code) => {
                    resolve({
                        stdout,
                        stderr,
                        exitCode: code || 0,
                    });
                });

                child.on('error', (error) => {
                    resolve({
                        stdout,
                        stderr: error.message,
                        exitCode: 1,
                    });
                });
            });

            const executionTime = Date.now() - startTime;

            return {
                success: result.exitCode === 0,
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
                command: context.command,
                executionTime,
                workingDir,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});
