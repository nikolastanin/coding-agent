import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Function to find project root by looking for package.json and src directory
function findProjectRoot(startDir: string): string {
  let currentDir = startDir;

  while (currentDir !== dirname(currentDir)) {
    const hasPackageJson = existsSync(join(currentDir, 'package.json'));
    const hasSrcDir = existsSync(join(currentDir, 'src'));

    // Look for a directory that has both package.json and src directory
    // and is not a build output directory
    if (hasPackageJson && hasSrcDir && !currentDir.includes('.mastra/output')) {
      return currentDir;
    }
    currentDir = dirname(currentDir);
  }

  throw new Error('Could not find project root (package.json and src directory not found)');
}

// Prompt file paths configuration (relative to project root)
export const PROMPTS = {
  CODING_AGENT_LOCAL: 'src/prompts/prompt-01.txt',
  // Add more prompt files here as needed
} as const;

// Utility function to read prompt files
export function readPromptFile(promptPath: string): string {
  try {
    const projectRoot = findProjectRoot(__dirname);
    const fullPath = join(projectRoot, promptPath);

    if (!existsSync(fullPath)) {
      console.error(`File does not exist: ${fullPath}`);
      console.error(`Project root: ${projectRoot}`);
      console.error(`Looking for: ${promptPath}`);
    }

    return readFileSync(fullPath, 'utf-8');
  } catch (error) {
    console.error(`Failed to read prompt file: ${promptPath}`, error);
    throw new Error(`Prompt file not found: ${promptPath}`);
  }
}

// Helper function to get specific prompts
export function getPrompt(promptKey: keyof typeof PROMPTS): string {
  return readPromptFile(PROMPTS[promptKey]);
}
