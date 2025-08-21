import { createTool } from '@mastra/core/tools';
import z from 'zod';
import { Daytona } from '@daytonaio/sdk';

// Global state manager for sandbox ID
class SandboxStateManager {
    private static instance: SandboxStateManager;
    private currentSandboxId: string | null = null;
    private daytonaClient: Daytona | null = null;

    private constructor() {}

    public static getInstance(): SandboxStateManager {
        if (!SandboxStateManager.instance) {
            SandboxStateManager.instance = new SandboxStateManager();
        }
        return SandboxStateManager.instance;
    }

    public setDaytonaClient(client: Daytona): void {
        this.daytonaClient = client;
    }

    public getDaytonaClient(): Daytona {
        if (!this.daytonaClient) {
            throw new Error('Daytona client not initialized. Please set up API key first.');
        }
        return this.daytonaClient;
    }

    public setSandboxId(sandboxId: string): void {
        this.currentSandboxId = sandboxId;
    }

    public getSandboxId(): string | null {
        return this.currentSandboxId;
    }

    public hasSandboxId(): boolean {
        return this.currentSandboxId !== null;
    }
}

// Get the singleton instance
const sandboxState = SandboxStateManager.getInstance();

// Rate limiting delay to prevent API rate limits
const RATE_LIMIT_DELAY = 1500; // 1.5 seconds between tool executions

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const withRateLimit = async <T>(fn: () => Promise<T>): Promise<T> => {
  await delay(RATE_LIMIT_DELAY);
  return fn();
};

// Helper function to get current sandboxId or throw error if none exists
function getCurrentSandboxId(): string {
    const sandboxId = sandboxState.getSandboxId();
    if (!sandboxId) {
        throw new Error('No sandbox ID available. Please create a sandbox first using createSandbox tool.');
    }
    return sandboxId;
}

export const initializeDaytona = createTool({
    id: 'initializeDaytona',
    description: 'Initialize the Daytona client with API key',
    inputSchema: z.object({
        apiKey: z.string().describe('Your Daytona API key'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the Daytona client was initialized successfully'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from failed initialization'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            const daytona = new Daytona({ apiKey: context.apiKey });
            sandboxState.setDaytonaClient(daytona);
            
            return {
                success: true,
            };
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const createProject = createTool({
    id: 'createProject',
    description: 'Create a Daytona sandbox project',
    inputSchema: z.object({
        metadata: z.record(z.string()).optional().describe('Custom metadata for the project (stored in .project file)'),
        envs: z.record(z.string()).optional().describe(`
      Custom environment variables for the project.
      Used when executing commands and code in the project.
      Can be overridden with the \`envs\` argument when executing commands or code.
    `),
        timeoutMS: z.number().optional().describe(`
      Timeout for operations in **milliseconds**.
      @default 1_800_000 // 30 minutes
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
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.create({
                    language: 'typescript',
                });

                // Clone the lovable-boilerplate repository into a temp directory first
                const gitCloneResult = await sandbox.process.codeRun(`
                    import os
                    import subprocess
                    
                    # Clone the repository
                    result = subprocess.run(['git', 'clone', 'https://github.com/chihebnabil/lovable-boilerplate', 'temp-repo'], 
                                         capture_output=True, text=True, cwd='/workspace')
                    print(f"Git clone result: {result.returncode}")
                    if result.stderr:
                        print(f"Git clone stderr: {result.stderr}")
                    
                    # Move all files from temp-repo to root directory
                    if result.returncode == 0:
                        move_result = subprocess.run(['sh', '-c', 'mv temp-repo/* temp-repo/.* . 2>/dev/null || true'], 
                                                  capture_output=True, text=True, cwd='/workspace')
                        print(f"Move result: {move_result.returncode}")
                        
                        # Remove the temp directory
                        cleanup_result = subprocess.run(['rm', '-rf', 'temp-repo'], 
                                                     capture_output=True, text=True, cwd='/workspace')
                        print(f"Cleanup result: {cleanup_result.returncode}")
                        
                        # Run npm install
                        npm_result = subprocess.run(['npm', 'install'], 
                                                 capture_output=True, text=True, cwd='/workspace')
                        print(f"NPM install result: {npm_result.returncode}")
                        if npm_result.stderr:
                            print(f"NPM install stderr: {npm_result.stderr}")
                `);

                if (gitCloneResult.result.includes('error') || gitCloneResult.result.includes('failed')) {
                    throw new Error(`Project setup failed: ${gitCloneResult.result}`);
                }

                // Store project metadata if provided
                if (projectOptions.metadata || projectOptions.envs) {
                    const projectConfig = {
                        metadata: projectOptions.metadata || {},
                        envs: projectOptions.envs || {},
                        createdAt: new Date().toISOString(),
                    };
                    await sandbox.process.codeRun(`
                        import json
                        with open('.project', 'w') as f:
                            json.dump(${JSON.stringify(projectConfig)}, f, indent=2)
                    `);
                }

                // Store the projectId in global state for other tools to use
                sandboxState.setSandboxId(sandbox.id);
                
                return {
                    projectId: sandbox.id,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const createSandbox = createTool({
    id: 'createSandbox',
    description: 'Create a Daytona sandbox',
    inputSchema: z.object({
        metadata: z.record(z.string()).optional().describe('Custom metadata for the sandbox'),
        envs: z.record(z.string()).optional().describe(`
      Custom environment variables for the sandbox.
      Used when executing commands and code in the sandbox.
      Can be overridden with the \`envs\` argument when executing commands or code.
    `),
        timeoutMS: z.number().optional().describe(`
      Timeout for the sandbox in **milliseconds**.
      Maximum time a sandbox can be kept alive is 24 hours (86_400_000 milliseconds) for Pro users and 1 hour (3_600_000 milliseconds) for Hobby users.
      @default 1_800_000 // 30 minutes
    `),
    }),
    outputSchema: z
        .object({
            sandboxId: z.string(),
        })
        .or(
            z.object({
                error: z.string(),
            }),
        ),
    execute: async ({ context: sandboxOptions }) => {
        return withRateLimit(async () => {
            try {
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.create({
                    language: 'typescript',
                });

                // Store the sandboxId in global state for other tools to use
                sandboxState.setSandboxId(sandbox.id);
                
                return {
                    sandboxId: sandbox.id,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const runCode = createTool({
    id: 'runCode',
    description: 'Run code in a Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to run the code (optional, will use current sandbox if not provided)'),
        code: z.string().describe('The code to run in the sandbox'),
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
            try {
                // Use provided sandboxId or get from global state
                const sandboxId = context.sandboxId || getCurrentSandboxId();
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.get(sandboxId);

                const execution = await sandbox.process.codeRun(context.code);

                return {
                    execution: JSON.stringify(execution),
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const readFile = createTool({
    id: 'readFile',
    description: 'Read a file from the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to read the file from (optional, will use current sandbox if not provided)'),
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
            try {
                // Use provided sandboxId or get from global state
                const sandboxId = context.sandboxId || getCurrentSandboxId();
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.get(sandboxId);
                
                const fileContent = await sandbox.process.codeRun(`
                    try:
                        with open('${context.path}', 'r') as f:
                            content = f.read()
                        print(content)
                    except Exception as e:
                        print(f"Error reading file: {e}")
                `);

                return {
                    content: fileContent.result,
                    path: context.path,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const writeFile = createTool({
    id: 'writeFile',
    description: 'Write a single file to the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to write the file to (optional, will use current sandbox if not provided)'),
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
            try {
                // Use provided sandboxId or get from global state
                const sandboxId = context.sandboxId || getCurrentSandboxId();
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.get(sandboxId);
                
                await sandbox.process.codeRun(`
                    import os
                    
                    # Ensure directory exists
                    os.makedirs(os.path.dirname('${context.path}'), exist_ok=True)
                    
                    # Write the file
                    with open('${context.path}', 'w') as f:
                        f.write('''${context.content}''')
                    
                    print(f"File written successfully to {context.path}")
                `);

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
    },
});

export const writeFiles = createTool({
    id: 'writeFiles',
    description: 'Write multiple files to the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to write the files to (optional, will use current sandbox if not provided)'),
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
            try {
                // Use provided sandboxId or get from global state
                const sandboxId = context.sandboxId || getCurrentSandboxId();
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.get(sandboxId);
                
                const filesData = context.files.map(file => ({
                    path: file.path,
                    data: file.data.replace(/'/g, "\\'").replace(/\n/g, '\\n')
                }));
                
                await sandbox.process.codeRun(`
                    import os
                    
                    files_data = ${JSON.stringify(filesData)}
                    
                    for file_info in files_data:
                        # Ensure directory exists
                        os.makedirs(os.path.dirname(file_info['path']), exist_ok=True)
                        
                        # Write the file
                        with open(file_info['path'], 'w') as f:
                            f.write(file_info['data'])
                        
                        print(f"File written: {file_info['path']}")
                `);

                return {
                    success: true,
                    filesWritten: context.files.map(file => file.path),
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
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
                
                // Verify the sandbox exists by trying to connect to it
                try {
                    const daytona = sandboxState.getDaytonaClient();
                    await daytona.get(projectId);
                } catch {
                    return {
                        error: `Project does not exist or is not accessible: ${projectId}`,
                    };
                }
                
                // Set the sandbox ID in global state
                sandboxState.setSandboxId(projectId);
                
                return {
                    success: true,
                    projectId,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const setSandboxId = createTool({
    id: 'setSandboxId',
    description: 'Set the current sandbox ID manually (useful when you know the sandboxId from a previous session)',
    inputSchema: z.object({
        sandboxId: z.string().describe('The sandbox ID to set as current'),
    }),
    outputSchema: z
        .object({
            success: z.boolean().describe('Whether the sandbox ID was set successfully'),
            sandboxId: z.string().describe('The sandbox ID that was set'),
        })
        .or(
            z.object({
                error: z.string().describe('The error if setting the sandbox ID failed'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                const sandboxId = context.sandboxId;
                
                // Verify the sandbox exists by trying to connect to it
                try {
                    const daytona = sandboxState.getDaytonaClient();
                    await daytona.get(sandboxId);
                } catch {
                    return {
                        error: `Sandbox does not exist or is not accessible: ${sandboxId}`,
                    };
                }
                
                // Set the sandbox ID in global state
                sandboxState.setSandboxId(sandboxId);
                
                return {
                    success: true,
                    sandboxId,
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
        })
        .or(
            z.object({
                error: z.string().describe('The error if no project is currently active'),
            }),
        ),
    execute: async () => {
        return withRateLimit(async () => {
            try {
                const projectId = getCurrentSandboxId();
                
                return {
                    projectId,
                };
            } catch (e) {
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});

export const getCurrentSandbox = createTool({
    id: 'getCurrentSandbox',
    description: 'Get information about the current sandbox',
    inputSchema: z.object({}),
    outputSchema: z
        .object({
            sandboxId: z.string().describe('The current sandbox ID'),
        })
        .or(
            z.object({
                error: z.string().describe('The error if no sandbox is currently active'),
            }),
        ),
    execute: async () => {
        return withRateLimit(async () => {
            try {
                const sandboxId = getCurrentSandboxId();
                
                return {
                    sandboxId,
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
    description: 'List files and directories in a path within the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to list files from (optional, will use current sandbox if not provided)'),
        path: z.string().default('/').describe('The directory path to list files from'),
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
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            const result = await sandbox.process.codeRun(`
                import os
                import json
                
                try:
                    path = '${context.path}'
                    files = []
                    
                    for item in os.listdir(path):
                        item_path = os.path.join(path, item)
                        is_dir = os.path.isdir(item_path)
                        files.append({
                            'name': item,
                            'path': item_path,
                            'isDirectory': is_dir
                        })
                    
                    print(json.dumps(files))
                except Exception as e:
                    print(f"Error listing files: {e}")
            `);

            try {
                const files = JSON.parse(result.result);
                return {
                    files,
                    path: context.path,
                };
            } catch (e) {
                return {
                    error: `Failed to parse file listing result: ${result.result}`,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const deleteFile = createTool({
    id: 'deleteFile',
    description: 'Delete a file or directory from the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to delete the file from (optional, will use current sandbox if not provided)'),
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
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            await sandbox.process.codeRun(`
                import os
                import shutil
                
                try:
                    path = '${context.path}'
                    if os.path.isfile(path):
                        os.remove(path)
                        print(f"File deleted: {path}")
                    elif os.path.isdir(path):
                        shutil.rmtree(path)
                        print(f"Directory deleted: {path}")
                    else:
                        print(f"Path does not exist: {path}")
                except Exception as e:
                    print(f"Error deleting: {e}")
            `);

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
    description: 'Create a directory in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to create the directory in (optional, will use current sandbox if not provided)'),
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
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            await sandbox.process.codeRun(`
                import os
                
                try:
                    path = '${context.path}'
                    os.makedirs(path, exist_ok=True)
                    print(f"Directory created: {path}")
                except Exception as e:
                    print(f"Error creating directory: {e}")
            `);

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
    description: 'Get detailed information about a file or directory in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to get file information from (optional, will use current sandbox if not provided)'),
        path: z.string().describe('The path to the file or directory to get information about'),
    }),
    outputSchema: z
        .object({
            name: z.string().describe('The name of the file or directory'),
            type: z.string().optional().describe('Whether this is a file or directory'),
            path: z.string().describe('The full path of the file or directory'),
            size: z.number().describe('The size of the file or directory in bytes'),
            mode: z.number().describe('The file mode (permissions as octal number)'),
            permissions: z.string().describe('Human-readable permissions string'),
            owner: z.string().describe('The owner of the file or directory'),
            group: z.string().describe('The group of the file or directory'),
            modifiedTime: z.string().optional().describe('The last modified time in ISO string format'),
            symlinkTarget: z.string().optional().describe('The target path if this is a symlink, null otherwise'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed file info request'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            const result = await sandbox.process.codeRun(`
                import os
                import stat
                import json
                from datetime import datetime
                
                try:
                    path = '${context.path}'
                    stat_info = os.stat(path)
                    
                    info = {
                        'name': os.path.basename(path),
                        'type': 'directory' if os.path.isdir(path) else 'file',
                        'path': path,
                        'size': stat_info.st_size,
                        'mode': stat_info.st_mode,
                        'permissions': stat.filemode(stat_info.st_mode),
                        'owner': 'unknown',  # Daytona may not provide user info
                        'group': 'unknown',  # Daytona may not provide group info
                        'modifiedTime': datetime.fromtimestamp(stat_info.st_mtime).isoformat(),
                        'symlinkTarget': os.readlink(path) if os.path.islink(path) else None
                    }
                    
                    print(json.dumps(info))
                except Exception as e:
                    print(f"Error getting file info: {e}")
            `);

            try {
                const info = JSON.parse(result.result);
                return {
                    name: info.name,
                    type: info.type,
                    path: info.path,
                    size: info.size,
                    mode: info.mode,
                    permissions: info.permissions,
                    owner: info.owner,
                    group: info.group,
                    modifiedTime: info.modifiedTime,
                    symlinkTarget: info.symlinkTarget,
                };
            } catch (e) {
                return {
                    error: `Failed to parse file info result: ${result.result}`,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const checkFileExists = createTool({
    id: 'checkFileExists',
    description: 'Check if a file or directory exists in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to check file existence in (optional, will use current sandbox if not provided)'),
        path: z.string().describe('The path to check for existence'),
    }),
    outputSchema: z
        .object({
            exists: z.boolean().describe('Whether the file or directory exists'),
            path: z.string().describe('The path that was checked'),
            type: z.string().optional().describe('The type if the path exists'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed existence check'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            const result = await sandbox.process.codeRun(`
                import os
                import json
                
                try:
                    path = '${context.path}'
                    exists = os.path.exists(path)
                    
                    if exists:
                        info = {
                            'exists': True,
                            'path': path,
                            'type': 'directory' if os.path.isdir(path) else 'file'
                        }
                    else:
                        info = {
                            'exists': False,
                            'path': path
                        }
                    
                    print(json.dumps(info))
                except Exception as e:
                    print(f"Error checking file existence: {e}")
            `);

            try {
                const info = JSON.parse(result.result);
                return {
                    exists: info.exists,
                    path: info.path,
                    type: info.type,
                };
            } catch (e) {
                return {
                    error: `Failed to parse existence check result: ${result.result}`,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const watchDirectory = createTool({
    id: 'watchDirectory',
    description: 'Start watching a directory for file system changes in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to watch directory in (optional, will use current sandbox if not provided)'),
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
                        type: z.string().describe('The type of filesystem event (WRITE, CREATE, DELETE, etc.)'),
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
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            // For Daytona, we'll simulate watching by checking for changes at intervals
            const events: Array<{ type: string; name: string; timestamp: string }> = [];
            
            // Get initial file list
            const initialResult = await sandbox.process.codeRun(`
                import os
                import json
                
                try:
                    path = '${context.path}'
                    files = []
                    
                    for item in os.listdir(path):
                        item_path = os.path.join(path, item)
                        is_dir = os.path.isdir(item_path)
                        files.append({
                            'name': item,
                            'path': item_path,
                            'isDirectory': is_dir,
                            'mtime': os.path.getmtime(item_path)
                        })
                    
                    print(json.dumps(files))
                except Exception as e:
                    print(f"Error listing files: {e}")
            `);
            
            let initialFiles = [];
            try {
                initialFiles = JSON.parse(initialResult.result);
            } catch (e) {
                return {
                    error: `Failed to parse initial file list: ${initialResult.result}`,
                };
            }
            
            // Wait for the specified duration
            await new Promise(resolve => setTimeout(resolve, context.watchDuration));
            
            // Get final file list and compare
            const finalResult = await sandbox.process.codeRun(`
                import os
                import json
                
                try:
                    path = '${context.path}'
                    files = []
                    
                    for item in os.listdir(path):
                        item_path = os.path.join(path, item)
                        is_dir = os.path.isdir(item_path)
                        files.append({
                            'name': item,
                            'path': item_path,
                            'isDirectory': is_dir,
                            'mtime': os.path.getmtime(item_path)
                        })
                    
                    print(json.dumps(files))
                except Exception as e:
                    print(f"Error listing files: {e}")
            `);
            
            let finalFiles = [];
            try {
                finalFiles = JSON.parse(finalResult.result);
            } catch (e) {
                return {
                    error: `Failed to parse final file list: ${finalResult.result}`,
                };
            }
            
            // Simple change detection (this is a basic implementation)
            const initialNames = new Set(initialFiles.map((f: any) => f.name));
            const finalNames = new Set(finalFiles.map((f: any) => f.name));
            
            // Check for new files
            for (const file of finalFiles) {
                if (!initialNames.has(file.name)) {
                    events.push({
                        type: 'CREATE',
                        name: file.name,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
            
            // Check for deleted files
            for (const file of initialFiles) {
                if (!finalNames.has(file.name)) {
                    events.push({
                        type: 'DELETE',
                        name: file.name,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
            
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

export const getFileSize = createTool({
    id: 'getFileSize',
    description: 'Get the size of a file or directory in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to get file size from (optional, will use current sandbox if not provided)'),
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
            type: z.string().optional().describe('Whether this is a file or directory'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed size check'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            
            const result = await sandbox.process.codeRun(`
                import os
                import json
                
                try:
                    path = '${context.path}'
                    stat_info = os.stat(path)
                    size = stat_info.st_size
                    is_dir = os.path.isdir(path)
                    
                    info = {
                        'size': size,
                        'path': path,
                        'type': 'directory' if is_dir else 'file'
                    }
                    
                    if ${context.humanReadable}:
                        sizes = ['B', 'KB', 'MB', 'GB', 'TB']
                        if size == 0:
                            info['humanReadableSize'] = '0 B'
                        else:
                            i = int(math.log(size, 1024))
                            human_size = (size / (1024 ** i))
                            info['humanReadableSize'] = f"{human_size:.1f} {sizes[i]}"
                    
                    print(json.dumps(info))
                except Exception as e:
                    print(f"Error getting file size: {e}")
            `);

            try {
                const info = JSON.parse(result.result);
                return {
                    size: info.size,
                    humanReadableSize: info.humanReadableSize,
                    path: info.path,
                    type: info.type,
                };
            } catch (e) {
                return {
                    error: `Failed to parse file size result: ${result.result}`,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const runCommand = createTool({
    id: 'runCommand',
    description: 'Run a shell command in the Daytona sandbox',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to run the command in (optional, will use current sandbox if not provided)'),
        command: z.string().describe('The shell command to execute'),
        workingDirectory: z.string().optional().describe('The working directory to run the command in'),
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
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed command execution'),
            }),
        ),
    execute: async ({ context }) => {
        try {
            // Use provided sandboxId or get from global state
            const sandboxId = context.sandboxId || getCurrentSandboxId();
            const daytona = sandboxState.getDaytonaClient();
            const sandbox = await daytona.get(sandboxId);
            const startTime = Date.now();

            const result = await sandbox.process.codeRun(`
                import subprocess
                import time
                import json
                
                start_time = time.time()
                
                try:
                    cmd = '${context.command}'
                    cwd = '${context.workingDirectory || '/workspace'}'
                    
                    process = subprocess.run(
                        cmd,
                        shell=True,
                        cwd=cwd,
                        capture_output=True,
                        text=True,
                        timeout=${context.timeoutMs / 1000}
                    )
                    
                    execution_time = (time.time() - start_time) * 1000
                    
                    result = {
                        'success': process.returncode == 0,
                        'exitCode': process.returncode,
                        'stdout': process.stdout,
                        'stderr': process.stderr,
                        'command': cmd,
                        'executionTime': execution_time
                    }
                    
                    print(json.dumps(result))
                except subprocess.TimeoutExpired:
                    print(json.dumps({
                        'success': False,
                        'exitCode': -1,
                        'stdout': '',
                        'stderr': 'Command timed out',
                        'command': '${context.command}',
                        'executionTime': ${context.timeoutMs}
                    }))
                except Exception as e:
                    print(json.dumps({
                        'success': False,
                        'exitCode': -1,
                        'stdout': '',
                        'stderr': str(e),
                        'command': '${context.command}',
                        'executionTime': (time.time() - start_time) * 1000
                    }))
            `);

            try {
                const commandResult = JSON.parse(result.result);
                return commandResult;
            } catch (e) {
                return {
                    error: `Failed to parse command result: ${result.result}`,
                };
            }
        } catch (e) {
            return {
                error: JSON.stringify(e),
            };
        }
    },
});

export const serveSitePreview = createTool({
    id: 'serveSitePreview',
    description: 'Build and serve a site from the root directory with Daytona preview',
    inputSchema: z.object({
        sandboxId: z.string().optional().describe('The sandboxId for the sandbox to serve the site from (optional, will use current sandbox if not provided)'),
        port: z.number().default(3000).describe('The port to serve the site on (must be in range 3000-9999 for Daytona preview)'),
    }),
    outputSchema: z
        .object({
            url: z.string().describe('The public preview URL for the site'),
            sandboxId: z.string().describe('The sandbox ID'),
            success: z.boolean().describe('Whether the site was built and served successfully'),
            previewToken: z.string().describe('The authorization token for accessing the preview'),
        })
        .or(
            z.object({
                error: z.string().describe('The error from a failed build or serve'),
            }),
        ),
    execute: async ({ context }) => {
        return withRateLimit(async () => {
            try {
                console.log('Starting serveSitePreview with Daytona...');
                
                // Use provided sandboxId or get from global state
                const sandboxId = context.sandboxId || getCurrentSandboxId();
                console.log('Connecting to sandbox:', sandboxId);
                
                const daytona = sandboxState.getDaytonaClient();
                const sandbox = await daytona.get(sandboxId);
                console.log('Connected to sandbox successfully');
                
                // Check if package.json exists in root
                console.log('Checking for package.json in root...');
                try {
                    const packageJsonResult = await sandbox.process.codeRun(`
                        try:
                            with open('/workspace/package.json', 'r') as f:
                                content = f.read()
                            print("Found package.json in root")
                        except:
                            print("No package.json in root")
                    `);
                    console.log('Package.json check result:', packageJsonResult.result);
                } catch (e) {
                    console.log('Error checking package.json:', e);
                }
                
                // Install dependencies
                console.log('Installing dependencies...');
                const installResult = await sandbox.process.codeRun(`
                    import subprocess
                    import os
                    
                    try:
                        # Change to workspace directory
                        os.chdir('/workspace')
                        
                        # Run npm install
                        result = subprocess.run(['npm', 'install'], 
                                             capture_output=True, text=True, timeout=300)
                        print(f"NPM install exit code: {result.returncode}")
                        if result.stderr:
                            print(f"NPM install stderr: {result.stderr}")
                        if result.stdout:
                            print(f"NPM install stdout: {result.stdout}")
                    except Exception as e:
                        print(f"Error during npm install: {e}")
                `);

                console.log('Install result:', installResult.result);

                // Build the project
                console.log('Building project...');
                const buildResult = await sandbox.process.codeRun(`
                    import subprocess
                    import os
                    
                    try:
                        # Change to workspace directory
                        os.chdir('/workspace')
                        
                        # Run npm run build
                        result = subprocess.run(['npm', 'run', 'build'], 
                                             capture_output=True, text=True, timeout=300)
                        print(f"Build exit code: {result.returncode}")
                        if result.stderr:
                            print(f"Build stderr: {result.stderr}")
                        if result.stdout:
                            print(f"Build stdout: {result.stdout}")
                    except Exception as e:
                        print(f"Error during build: {e}")
                `);

                console.log('Build result:', buildResult.result);

                // Start a simple HTTP server
                console.log('Starting HTTP server...');
                const serverResult = await sandbox.process.codeRun(`
                    import subprocess
                    import os
                    import time
                    
                    try:
                        # Change to workspace directory
                        os.chdir('/workspace')
                        
                        # Check if dist directory exists
                        if os.path.exists('dist'):
                            os.chdir('dist')
                        elif os.path.exists('build'):
                            os.chdir('build')
                        elif os.path.exists('public'):
                            os.chdir('public')
                        
                        # Start HTTP server in background
                        server_process = subprocess.Popen(
                            ['python3', '-m', 'http.server', '${context.port}', '--bind', '0.0.0.0'],
                            stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE
                        )
                        
                        # Wait a bit for server to start
                        time.sleep(2)
                        
                        # Check if server is running
                        if server_process.poll() is None:
                            print(f"HTTP server started successfully on port ${context.port}")
                        else:
                            print("HTTP server failed to start")
                            
                    except Exception as e:
                        print(f"Error starting server: {e}")
                `);

                console.log('Server start result:', serverResult.result);

                // Get the preview link from Daytona
                console.log('Getting preview link...');
                const previewInfo = await sandbox.getPreviewLink(context.port);
                console.log('Preview info:', previewInfo);

                return {
                    url: previewInfo.url,
                    sandboxId: sandbox.id,
                    success: true,
                    previewToken: previewInfo.token,
                };
            } catch (e) {
                console.error('Error in serveSitePreview:', e);
                return {
                    error: JSON.stringify(e),
                };
            }
        });
    },
});
