import simpleGit from 'simple-git';
import * as vscode from 'vscode';
import { Logger } from './logger';

/**
 * Retrieves the staged changes from the Git repository.
 */
export async function getDiffStaged(
  repo: any
): Promise<{ diff: string; error?: string }> {
  try {
    const rootPath =
      repo?.rootUri?.fsPath || vscode.workspace.workspaceFolders?.[0].uri.fsPath;

    if (!rootPath) {
      throw new Error('No workspace folder found');
    }

    const git = simpleGit(rootPath);
    // Only ask Git for its own unified diff. `--no-ext-diff` and
    // `--no-textconv` prevent external diff drivers from returning full file
    // contents instead of the staged changes.
    const diff = await git.diff([
      '--staged',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color'
    ]);

    return {
      diff: diff || 'No changes staged.',
      error: null
    };
  } catch (error) {
    Logger.error('Error reading Git diff:', error);
    return { diff: '', error: error.message };
  }
}
