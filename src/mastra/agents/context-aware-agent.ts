import { Agent } from '@mastra/core/agent';
import { openai } from '@ai-sdk/openai';
import { google } from '@ai-sdk/google';
import { togetherai } from '@ai-sdk/togetherai';
import { ContextManager, Msg } from './ContextManager';
import { SUMMARIZE_PROMPT, FACTS_PROMPT, safeParseFacts } from './context-prompts';
import { getPrompt, PROMPTS } from '../config/prompts';
import {
    checkFileExists,
    createDirectory,
    createProject,
    deleteFile,
    getFileInfo,
    getFileSize,
    getCurrentProject,
    listFiles,
    readFile,
    runCode,
    runCommand,
    setProjectId,
    watchDirectory,
    writeFile,
    servePreview,
    //writeFiles,
} from '../tools/daytona-tools';

import { escapeBackticks, readPromptFile } from '../misc/helper';
import { fastembed } from '@mastra/fastembed';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { Memory } from '@mastra/memory';

// Create the context manager with your static system prompt
const contextManager = new ContextManager([
    { role: "system", content: getPrompt('CODING_AGENT_LOCAL') }
]);

const googleModel = google('gemini-2.5-pro');

const openaiModel = openai('gpt-4.1-2025-04-14');
const togetheraiModel = togetherai('meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8');

const prompt = readPromptFile('../../src/mastra/misc/prompt_with_xml.txt');

// Create the enhanced agent with context management
export const contextAwareAgent = new Agent({
    name: 'Context-Aware Coding Agent Local',
    instructions: escapeBackticks(prompt),
    model: googleModel,
    tools: {
        createProject,
        getCurrentProject,
        setProjectId,
        runCode,
        readFile,
        writeFile,
        //writeFiles,
        listFiles,
        deleteFile,
        createDirectory,
        getFileInfo,
        checkFileExists,
        getFileSize,
        watchDirectory,
        runCommand,
        servePreview,
    },
    memory: new Memory({
        storage: new LibSQLStore({ url: 'file:../../mastra.db' }),
        options: {
            threads: { generateTitle: true },
            semanticRecall: true,
            workingMemory: {
                 enabled: true,
                 scope: 'thread',
                 template: `#Project Context
- **ProjectId**: [Use getCurrentProject to track the current project ID]
- **Project Path**: [Use getCurrentProject to track the current project path]
- **Project Files**: [Use listFiles to explore project structure]
- **Project Context**: [Track what we're working on]
- **Project Goals**: [What the user wants to build]
- **Changed files**: [Track files we've modified]
- **Current file that we are working on**: [Current focus]
`,
            },
        },
        embedder: fastembed,
        vector: new LibSQLVector({ connectionUrl: 'file:../../mastra.db' }),
    }),
    defaultStreamOptions: { maxSteps:100 },
});

// Export the context manager for external use
export { contextManager };

// Note: Tools now automatically use the current project from global state
// No need to pass projectId to most tools - they will use the current project automatically
// Only pass projectId when you want to work with a different project
