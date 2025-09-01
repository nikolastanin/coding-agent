import fs from 'fs';

export const escapeBackticks = (str: string): string => {
    return str.replace(/`/g, '\\`');
  };

  export const readPromptFile = (path: string): string => {
    return fs.readFileSync(path, 'utf8');
  };