# E2B Local Tools - Project ID Management

## Overview

The E2B Local tools now automatically manage project IDs through a global state manager. This means you no longer need to pass `projectId` to most tools - they will automatically use the current project.

## How It Works

### 1. Project Creation
When you call `createProject`, the tool:
- Creates a new project directory
- Generates a unique project ID
- Stores the project ID in global state
- Returns the project ID

### 2. Automatic Project Usage
All other tools automatically:
- Check if a `projectId` is provided in their parameters
- If no `projectId` is provided, they use the current project from global state
- If a `projectId` is provided, they use that specific project

### 3. Global State Management
The system uses a singleton `ProjectStateManager` that:
- Stores the current active project ID
- Provides methods to get/set the current project
- Ensures consistency across all tool calls

## Tool Usage Examples

### Before (Old Way)
```typescript
// Had to pass projectId to every tool
await readFile({ projectId: "project_abc123", path: "src/index.tsx" });
await writeFile({ projectId: "project_abc123", path: "src/new.tsx", content: "..." });
await listFiles({ projectId: "project_abc123", path: "./" });
```

### After (New Way)
```typescript
// No projectId needed - tools use current project automatically
await readFile({ path: "src/index.tsx" });
await writeFile({ path: "src/new.tsx", content: "..." });
await listFiles({ path: "./" });

// Still can override with specific projectId if needed
await readFile({ projectId: "different_project", path: "src/index.tsx" });
```

## Available Tools

### Project Management
- `createProject` - Creates new project and sets it as current
- `getCurrentProject` - Gets info about current project
- `setProjectId` - Manually sets current project

### File Operations (Auto-use current project)
- `readFile` - Read file contents
- `writeFile` - Write single file
- `writeFiles` - Write multiple files
- `listFiles` - List directory contents
- `deleteFile` - Delete file/directory
- `createDirectory` - Create directory
- `checkFileExists` - Check file existence
- `getFileInfo` - Get file metadata
- `getFileSize` - Get file size

### Code Execution (Auto-use current project)
- `runCode` - Execute code
- `runCommand` - Run shell commands

### Monitoring (Auto-use current project)
- `watchDirectory` - Watch for file changes

## Benefits

1. **Simplified Usage**: No need to pass projectId to every tool call
2. **Consistent State**: All tools work with the same project by default
3. **Flexibility**: Still can override with specific projectId when needed
4. **Error Prevention**: Automatic fallback to current project prevents errors
5. **Better UX**: Users don't need to remember or manage project IDs

## Migration

If you have existing code that passes projectId to every tool:
1. Remove the `projectId` parameter from tool calls
2. Tools will automatically use the current project
3. Only keep `projectId` when you need to work with a different project

## Error Handling

If no project is set and you try to use a tool:
- Tools will throw an error: "No project ID available. Please create a project first using createProject tool."
- Use `createProject` first to set up a project
- Or use `setProjectId` to set an existing project as current
