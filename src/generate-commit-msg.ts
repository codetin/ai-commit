import * as fs from 'fs-extra';
import { ChatCompletionMessageParam } from 'openai/resources';
import * as vscode from 'vscode';
import { ConfigKeys, ConfigurationManager } from './config';
import { prepareDiffPayload, splitStagedDiffByFile } from './diff-utils';
import { getDiffStaged } from './git-utils';
import { ChatGPTAPI, ResponsesAPI } from './openai-utils';
import { getMainCommitPrompt } from './prompts';
import { ProgressHandler } from './utils';
import { GeminiAPI } from './gemini-utils';
import { ClaudeAPI } from './claude-utils';
import { Logger } from './logger';

interface ChatMessage {
  role: string;
  content: string;
}

const MERGE_INSTRUCTION = `## Merge Task

You will receive commit messages that were generated separately for individual files.
Merge them into ONE final commit message that follows all the rules above.
- Remove duplicate or overlapping entries
- Combine related changes
- Keep the most important types and scopes
- Do not mention that the diff was split
- Output ONLY the final commit message`;

/**
 * Removes reasoning blocks (for thinking models) and trims the result.
 */
function cleanCommitMessage(message: string): string {
  return message.replace(/.*?<\/think>/gs, '').trim();
}

/**
 * Generates a chat completion prompt for the commit message based on the provided diff.
 *
 * @param {string} diff - The diff string representing changes to be committed.
 * @param {string} additionalContext - Additional context for the changes.
 * @returns {Promise<Array<{ role: string, content: string }>>} - A promise that resolves to an array of messages for the chat completion.
 */
const generateCommitMessageChatCompletionPrompt = async (
  diff: string,
  additionalContext?: string
): Promise<ChatMessage[]> => {
  const INIT_MESSAGES_PROMPT = await getMainCommitPrompt();
  const chatContextAsCompletionRequest: ChatMessage[] = [
    ...(INIT_MESSAGES_PROMPT as ChatMessage[])
  ];

  if (additionalContext) {
    chatContextAsCompletionRequest.push({
      role: 'user',
      content: `Additional context for the changes:\n${additionalContext}`
    });
  }

  chatContextAsCompletionRequest.push({
    role: 'user',
    content: diff
  });
  return chatContextAsCompletionRequest;
};

/**
 * Sends a request to the configured AI provider.
 */
async function callAI(
  messages: ChatMessage[],
  aiProvider: string,
  configManager: ConfigurationManager
): Promise<string | undefined> {
  if (aiProvider === 'gemini') {
    const geminiApiKey = configManager.getConfig<string>(
      ConfigKeys.GEMINI_API_KEY
    );
    if (!geminiApiKey) {
      throw new Error('Gemini API Key not configured');
    }
    return GeminiAPI(messages);
  }

  if (aiProvider === 'claude') {
    const claudeApiKey = configManager.getConfig<string>(
      ConfigKeys.CLAUDE_API_KEY
    );
    if (!claudeApiKey) {
      throw new Error('Claude API Key not configured');
    }
    return ClaudeAPI(messages);
  }

  const openaiApiKey = configManager.getConfig<string>(
    ConfigKeys.OPENAI_API_KEY
  );
  if (!openaiApiKey) {
    throw new Error('OpenAI API Key not configured');
  }

  const apiType = configManager.getConfig<string>(
    ConfigKeys.OPENAI_API_TYPE,
    'completion'
  );

  if (apiType === 'response') {
    return ResponsesAPI(messages as ChatCompletionMessageParam[]);
  }
  return ChatGPTAPI(messages as ChatCompletionMessageParam[]);
}

/**
 * Builds the prompt that merges per-file commit messages into one message.
 */
async function generateCommitMessageMergePrompt(
  perFileMessages: string[],
  additionalContext?: string
): Promise<ChatMessage[]> {
  const basePrompt = (await getMainCommitPrompt()) as ChatMessage[];
  const baseSystemPrompt = basePrompt
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const systemPrompt = [baseSystemPrompt, MERGE_INSTRUCTION]
    .filter(Boolean)
    .join('\n\n');

  const messageList = perFileMessages
    .map((message, index) => `### File ${index + 1}\n${message}`)
    .join('\n\n');

  const userContent = additionalContext
    ? `Additional context for the changes:\n${additionalContext}\n\nPer-file commit messages:\n\n${messageList}`
    : `Per-file commit messages:\n\n${messageList}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];
}

/**
 * Fallback merge that concatenates distinct commit message blocks when the
 * merge request itself fails.
 */
function mergeCommitMessagesLocally(messages: string[]): string {
  const blocks = messages
    .flatMap((message) => message.split(/\n{2,}/))
    .map((block) => block.trim())
    .filter(Boolean);

  return [...new Set(blocks)].join('\n\n');
}

/**
 * Splits an oversized staged diff into per-file requests, then asks the model
 * to merge the individual commit messages into one final message.
 *
 * If a single file's diff is larger than the budget, its compact local summary
 * is sent instead of the whole file diff.
 */
async function generateCommitMessageFromFiles(
  rawDiff: string,
  additionalContext: string,
  aiProvider: string,
  configManager: ConfigurationManager,
  maxDiffChars: number,
  progress: vscode.Progress<{ message?: string }>,
  token: vscode.CancellationToken
): Promise<string> {
  const files = splitStagedDiffByFile(rawDiff);

  if (files.length === 0) {
    throw new Error('No usable staged file diffs found');
  }

  if (files.length === 1) {
    const payload = prepareDiffPayload(files[0].diff, maxDiffChars);
    if (!payload.diff) {
      throw new Error(
        `The diff for ${files[0].filePath} could not be represented within DIFF_MAX_CHARS (${maxDiffChars})`
      );
    }
    const messages = await generateCommitMessageChatCompletionPrompt(
      payload.diff,
      additionalContext
    );
    const response = await callAI(messages, aiProvider, configManager);
    if (!response) {
      throw new Error('Failed to generate commit message');
    }
    return cleanCommitMessage(response);
  }

  const mergeMode = configManager.getConfig<string>(
    ConfigKeys.DIFF_PER_FILE_MERGE,
    'local'
  );
  const perFileContext = mergeMode === 'local' ? additionalContext : undefined;

  Logger.info(
    `Staged diff exceeded DIFF_MAX_CHARS; analyzing ${files.length} files separately (merge: ${mergeMode})`
  );

  const perFileMessages: string[] = [];

  for (let index = 0; index < files.length; index++) {
    if (token.isCancellationRequested) {
      throw new vscode.CancellationError();
    }

    const file = files[index];
    progress.report({
      message: `Analyzing ${file.filePath} (${index + 1}/${files.length})...`
    });

    const payload = prepareDiffPayload(file.diff, maxDiffChars);
    if (!payload.diff) {
      throw new Error(
        `The diff for ${file.filePath} could not be represented within DIFF_MAX_CHARS (${maxDiffChars})`
      );
    }

    const messages = await generateCommitMessageChatCompletionPrompt(
      payload.diff,
      perFileContext
    );

    try {
      const response = await callAI(messages, aiProvider, configManager);
      if (response) {
        const cleaned = cleanCommitMessage(response);
        if (cleaned) {
          perFileMessages.push(cleaned);
        }
      }
    } catch (err: any) {
      Logger.error(
        `Failed to generate a commit message for ${file.filePath}`,
        err
      );
      if (err instanceof Error) {
        err.message = `${file.filePath}: ${err.message}`;
      }
      throw err;
    }
  }

  if (perFileMessages.length === 0) {
    throw new Error('Failed to generate commit messages for the staged files');
  }

  if (mergeMode === 'ai') {
    progress.report({ message: 'Merging per-file commit messages with AI...' });

    try {
      const mergeMessages = await generateCommitMessageMergePrompt(
        perFileMessages,
        additionalContext
      );
      const merged = await callAI(mergeMessages, aiProvider, configManager);
      const cleaned = merged ? cleanCommitMessage(merged) : '';
      if (cleaned) {
        return cleaned;
      }
      Logger.warn(
        'Merge request returned no content; using local merge fallback'
      );
    } catch (err) {
      Logger.warn('Merge request failed; using local merge fallback', err);
    }
  } else {
    progress.report({ message: 'Combining per-file commit messages...' });
    Logger.info('Combining per-file commit messages locally');
  }

  return mergeCommitMessagesLocally(perFileMessages);
}

/**
 * Retrieves the repository associated with the provided argument.
 *
 * @param {any} arg - The input argument containing the root URI of the repository.
 * @returns {Promise<vscode.SourceControlRepository>} - A promise that resolves to the repository object.
 */
export async function getRepo(arg) {
  const gitApi = vscode.extensions.getExtension('vscode.git')?.exports.getAPI(1);
  if (!gitApi) {
    throw new Error('Git extension not found');
  }

  if (typeof arg === 'object' && arg.rootUri) {
    const resourceUri = arg.rootUri;
    const realResourcePath: string = fs.realpathSync(resourceUri!.fsPath);
    for (let i = 0; i < gitApi.repositories.length; i++) {
      const repo = gitApi.repositories[i];
      if (realResourcePath.startsWith(repo.rootUri.fsPath)) {
        return repo;
      }
    }
  }
  return gitApi.repositories[0];
}

/**
 * Generates a commit message based on the changes staged in the repository.
 *
 * @param {any} arg - The input argument containing the root URI of the repository.
 * @returns {Promise<void>} - A promise that resolves when the commit message has been generated and set in the SCM input box.
 */
export async function generateCommitMsg(arg) {
  return ProgressHandler.withProgress('', async (progress, token) => {
    let aiProvider = 'openai';

    try {
      const configManager = ConfigurationManager.getInstance();
      const repo = await getRepo(arg);

      aiProvider = configManager.getConfig<string>(
        ConfigKeys.AI_PROVIDER,
        'openai'
      );
      Logger.info(`Using AI provider: ${aiProvider}`);

      progress.report({ message: 'Getting staged changes...' });
      const { diff: rawDiff, error } = await getDiffStaged(repo);

      if (error) {
        throw new Error(`Failed to get staged changes: ${error}`);
      }

      if (!rawDiff || rawDiff === 'No changes staged.') {
        throw new Error('No changes staged for commit');
      }

      // Send only the staged unified diff to the AI, never the full contents
      // of the files that are about to be committed.
      const maxDiffChars = configManager.getConfig<number>(
        ConfigKeys.DIFF_MAX_CHARS,
        60000
      );
      const overflowStrategy = configManager.getConfig<string>(
        ConfigKeys.DIFF_OVERFLOW_STRATEGY,
        'summary'
      );
      const preparedDiff = prepareDiffPayload(rawDiff, maxDiffChars);

      if (preparedDiff.fileCount === 0) {
        throw new Error(
          'Git did not return a staged unified diff. Only diff content can be sent to the AI.'
        );
      }

      if (!preparedDiff.diff && overflowStrategy !== 'per-file') {
        throw new Error(
          `The staged diff is larger than DIFF_MAX_CHARS (${maxDiffChars}). Increase the limit or stage fewer files.`
        );
      }

      const scmInputBox = repo.inputBox;
      if (!scmInputBox) {
        throw new Error('Unable to find the SCM input box');
      }

      const additionalContext = scmInputBox.value.trim();
      let commitMessage: string | undefined;

      if (preparedDiff.truncated && overflowStrategy === 'per-file') {
        progress.report({
          message: `Diff is large; analyzing ${preparedDiff.fileCount} files separately...`
        });
        commitMessage = await generateCommitMessageFromFiles(
          rawDiff,
          additionalContext,
          aiProvider,
          configManager,
          maxDiffChars,
          progress,
          token
        );
      } else {
        Logger.info(
          `Sending diff payload: ${preparedDiff.fileCount} file(s), ${preparedDiff.diff.length} chars${
            preparedDiff.truncated
              ? `, ${preparedDiff.summarizedFiles.length} summarized`
              : ''
          }`
        );
        if (preparedDiff.truncated) {
          Logger.warn(
            `Staged diff exceeded DIFF_MAX_CHARS (${maxDiffChars}); sending a reduced diff payload`
          );
          if (preparedDiff.summarizedFiles.length > 0) {
            Logger.warn(
              `Diff replaced by local symbol summaries: ${preparedDiff.summarizedFiles.join(', ')}`
            );
          }
          if (preparedDiff.omittedFiles.length > 0) {
            Logger.warn(
              `Omitted files: ${preparedDiff.omittedFiles.join(', ')}`
            );
          }
          progress.report({
            message:
              'Diff is large; oversized files are represented by local function/class summaries...'
          });
        }

        progress.report({
          message: additionalContext
            ? 'Analyzing changes with additional context...'
            : 'Analyzing changes...'
        });
        const messages = await generateCommitMessageChatCompletionPrompt(
          preparedDiff.diff,
          additionalContext
        );

        progress.report({
          message: additionalContext
            ? 'Generating commit message with additional context...'
            : 'Generating commit message...'
        });
        commitMessage = await callAI(messages, aiProvider, configManager);
      }

      if (!commitMessage) {
        throw new Error('Failed to generate commit message');
      }

      commitMessage = cleanCommitMessage(commitMessage);
      Logger.info('Commit message generated successfully');
      scmInputBox.value = commitMessage;
    } catch (err: any) {
      if (err instanceof vscode.CancellationError) {
        throw err;
      }

      Logger.error('Commit message generation failed:', err);
      let errorMessage =
        (err instanceof Error && err.message) ||
        (typeof err === 'string' ? err : 'An unexpected error occurred');

      if (err?.response?.status) {
        switch (err.response.status) {
          case 401:
            errorMessage = 'Invalid API key or unauthorized access';
            break;
          case 429:
            errorMessage = 'Rate limit exceeded. Please try again later';
            break;
          case 500:
            errorMessage = 'AI provider server error. Please try again later';
            break;
          case 503:
            errorMessage = 'AI service is temporarily unavailable';
            break;
        }
      } else if (aiProvider === 'gemini') {
        errorMessage = `Gemini API error: ${err.message}`;
      } else if (aiProvider === 'claude') {
        errorMessage = `Claude API error: ${err.message}`;
      }

      throw new Error(errorMessage);
    }
  });
}