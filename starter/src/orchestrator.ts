import {
  query,
  type AgentDefinition,
  type Options,
} from '@anthropic-ai/claude-agent-sdk';

import {
  ReviewReportSchema,
  ReviewReportJSONSchema,
  type ReviewReport,
} from './types/index.js';

import {
  codeQualityAnalyzer,
  testCoverageAnalyzer,
  refactoringSuggester,
} from './agents/index.js';

import {
  buildOrchestratorPrompt,
} from './prompts/orchestrator.prompt.js';

import {
  mcpServersConfig,
} from './config/mcp.config.js';

import {
  ReviewError,
  ErrorCodes,
  withRetry,
  withTimeout,
} from './utils/error-handler.js';

import {
  logger,
} from './utils/logger.js';

export interface OrchestratorOptions {
  model?: string;
  maxTurns?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class CodeReviewOrchestrator {
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  private readonly agents: Record<
    string,
    AgentDefinition
  >;

  constructor(
    options: OrchestratorOptions = {},
  ) {
    const model =
      options.model ??
      process.env.ANTHROPIC_MODEL;

    if (!model) {
      throw new ReviewError(
        'ANTHROPIC_MODEL is required.',
        ErrorCodes.INVALID_CONFIG,
      );
    }

    this.model = model;

    this.maxTurns =
      options.maxTurns ??
      100;

    this.timeoutMs =
      options.timeoutMs ??
      300_000;

    this.maxRetries =
      options.maxRetries ??
      0;

    this.agents = {
      'code-quality-analyzer':
        codeQualityAnalyzer,

      'test-coverage-analyzer':
        testCoverageAnalyzer,

      'refactoring-suggester':
        refactoringSuggester,
    };
  }

  async reviewPullRequest(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewReport> {
    this.validateInput(
      owner,
      repo,
      prNumber,
    );

    logger.info(
      'Starting pull request review',
      {
        owner,
        repo,
        prNumber,
      },
    );

    const operation = () =>
      withTimeout(
        () =>
          this.executeReview(
            owner,
            repo,
            prNumber,
          ),
        this.timeoutMs,
      );

    try {
      if (this.maxRetries > 0) {
        return await withRetry(
          operation,
          this.maxRetries,
        );
      }

      return await operation();
    } catch (error) {
      if (error instanceof ReviewError) {
        throw error;
      }

      throw new ReviewError(
        error instanceof Error
          ? error.message
          : 'Unknown review failure.',
        ErrorCodes.UNKNOWN_ERROR,
        {
          owner,
          repo,
          prNumber,
        },
      );
    }
  }

  private async executeReview(
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<ReviewReport> {
    const prompt =
      buildOrchestratorPrompt(
        owner,
        repo,
        prNumber,
      );

    const outputSchema =
      ReviewReportJSONSchema;

    const options: Options = {
      model: this.model,

      maxTurns:
        this.maxTurns,

      allowedTools: [
        'Task',
        'Read',
        'Grep',
        'Glob',
        'Skill',
        'mcp__github__*',
        'mcp__eslint__*',
      ],

      agents:
        this.agents,

      mcpServers:
        mcpServersConfig,

      permissionMode:
        'bypassPermissions',

      outputFormat: {
        type: 'json_schema',
        schema: outputSchema,
      },
    };

    logger.info(
      'Starting Claude Agent SDK query',
      {
        owner,
        repo,
        prNumber,
        maxTurns:
          this.maxTurns,
        timeoutMs:
          this.timeoutMs,
      },
    );

    let structuredOutput:
      unknown = undefined;

    let finalResultSubtype:
      string | undefined;

    const response = query({
      prompt,
      options,
    });

    /*
     * Consume the async SDK response.
     */
    for await (
      const message of response
    ) {

      /*
       * TEMPORARY RAW SDK DIAGNOSTIC
       *
       * This lets us inspect the actual SDK
       * message structure for SDK 0.1.77.
       *
       * Remove this block after the runtime
       * issue has been diagnosed.
       */
      const candidate =
        message as {
          type?: string;
          subtype?: string;
          structured_output?: unknown;
        };

      /*
       * Capture structured output when
       * returned by the SDK.
       */
      if (
        candidate.structured_output !==
        undefined
      ) {
        structuredOutput =
          candidate.structured_output;

        logger.info(
          'Structured output received',
          {
            owner,
            repo,
            prNumber,
          },
        );
      }

      /*
       * Capture final SDK result status.
       */
      if (
        candidate.type === 'result'
      ) {
        finalResultSubtype =
          candidate.subtype;
      }

      /*
       * Safe diagnostic logging.
       */
      const diagnosticMessage =
        message as {
          type?: string;
          subtype?: string;
          tool_name?: string;
          name?: string;
          agent_name?: string;
          tool_use_id?: string;
          message?: {
            content?: unknown;
          };
        };

      const content =
        diagnosticMessage.message?.content;

      const contentItems =
        Array.isArray(content)
          ? content
          : [];

      const toolNames =
        contentItems
          .filter(
            (
              item,
            ): item is {
              type?: string;
              name?: string;
            } =>
              typeof item === 'object' &&
              item !== null,
          )
          .map(
            item =>
              item.name,
          )
          .filter(
            (
              name,
            ): name is string =>
              typeof name === 'string',
          );

      logger.info(
        'Claude SDK message',
        {
          type:
            diagnosticMessage.type,

          subtype:
            diagnosticMessage.subtype,

          toolName:
            diagnosticMessage.tool_name ??
            diagnosticMessage.name,

          agentName:
            diagnosticMessage.agent_name,

          contentToolNames:
            toolNames,

          hasStructuredOutput:
            diagnosticMessage.type ===
              'result' &&
            candidate.structured_output !==
              undefined,
        },
      );
    }

    if (
      finalResultSubtype &&
      finalResultSubtype !== 'success'
    ) {
      logger.error(
        'Claude Agent SDK review did not complete successfully',
        {
          owner,
          repo,
          prNumber,
          subtype:
            finalResultSubtype,
        },
      );
    }

    if (
      structuredOutput ===
      undefined
    ) {
      throw new ReviewError(
        'Claude Agent SDK did not return structured output.',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        {
          owner,
          repo,
          prNumber,
          subtype:
            finalResultSubtype,
        },
      );
    }

    /*
     * Validate the final output using
     * the application's Zod schema.
     */
    const validation =
      ReviewReportSchema.safeParse(
        structuredOutput,
      );

    if (!validation.success) {
      logger.error(
        'Structured output failed ReviewReport validation',
        {
          owner,
          repo,
          prNumber,
          issues:
            validation.error.issues,
        },
      );

      throw new ReviewError(
        'Structured output does not match ReviewReport schema.',
        ErrorCodes.STRUCTURED_OUTPUT_FAILED,
        {
          owner,
          repo,
          prNumber,
          issues:
            validation.error.issues,
        },
      );
    }

    logger.info(
      'Pull request review completed successfully',
      {
        owner,
        repo,
        prNumber,
        totalFiles:
          validation.data.summary.totalFiles,
      },
    );

    return validation.data;
  }

  private validateInput(
    owner: string,
    repo: string,
    prNumber: number,
  ): void {
    if (
      !owner ||
      owner.trim().length === 0
    ) {
      throw new ReviewError(
        'Repository owner is required.',
        ErrorCodes.INVALID_CONFIG,
      );
    }

    if (
      !repo ||
      repo.trim().length === 0
    ) {
      throw new ReviewError(
        'Repository name is required.',
        ErrorCodes.INVALID_CONFIG,
      );
    }

    if (
      !Number.isInteger(prNumber) ||
      prNumber <= 0
    ) {
      throw new ReviewError(
        'Pull request number must be a positive integer.',
        ErrorCodes.INVALID_CONFIG,
      );
    }
  }
}

export const Orchestrator =
  CodeReviewOrchestrator;