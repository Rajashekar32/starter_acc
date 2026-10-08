import * as dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { Orchestrator } from './orchestrator.js';
import { ReportGenerator } from './utils/report-generator.js';
import {
  formatError,
  isReviewError,
  ErrorCodes
} from './utils/error-handler.js';
import { logger } from './utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Main entry point for the Claude Multi-Agent Code Review System.
 *
 * Usage:
 *   npm run dev -- <owner> <repo> <pr-number>
 *
 * Example:
 *   npm run dev -- udacity cd14715-simple-todo-app 1
 */
async function main(): Promise<void> {
  const [owner, repo, prStr] =
    process.argv.slice(2);

  // ============================================================
  // 1. Validate command-line arguments
  // ============================================================

  if (!owner || !repo || !prStr) {
    console.error(`
Usage:
  npm run dev -- <owner> <repo> <pr-number>

Example:
  npm run dev -- udacity cd14715-simple-todo-app 1
`);

    process.exitCode = 1;
    return;
  }

  const prNumber = Number(prStr);

  if (
    !Number.isInteger(prNumber) ||
    prNumber <= 0
  ) {
    console.error(
      `❌ Invalid pull request number: "${prStr}". ` +
      'The PR number must be a positive integer.'
    );

    process.exitCode = 1;
    return;
  }

  // ============================================================
  // 2. Validate authentication
  // ============================================================

  const anthropicApiKey =
    process.env.ANTHROPIC_API_KEY;

  const awsAccessKey =
    process.env.AWS_ACCESS_KEY_ID;

  const awsSecretKey =
    process.env.AWS_SECRET_ACCESS_KEY;

  const awsRegion =
    process.env.AWS_REGION;

  const hasAnthropicAuth =
    Boolean(anthropicApiKey);

  const hasAwsAuth =
    Boolean(
      awsAccessKey &&
      awsSecretKey
    );

  if (
    !hasAnthropicAuth &&
    !hasAwsAuth
  ) {
    console.error(`
❌ No authentication method configured.

Choose one of the following:

Option 1 - Anthropic API:
  ANTHROPIC_API_KEY=your-api-key

Option 2 - AWS Bedrock:
  AWS_ACCESS_KEY_ID=your-access-key
  AWS_SECRET_ACCESS_KEY=your-secret-key
  AWS_REGION=your-region

Please configure one authentication method in your .env file.
`);

    process.exitCode = 1;
    return;
  }

  if (hasAnthropicAuth) {
    logger.info(
      '🔐 Using Anthropic API authentication'
    );
  } else {
    if (!awsRegion) {
      console.error(`
❌ AWS Bedrock authentication is configured,
but AWS_REGION is missing.

Please set:

  AWS_REGION=your-aws-region
`);

      process.exitCode = 1;
      return;
    }

    logger.info(
      '🔐 Using AWS Bedrock authentication'
    );
  }

  // ============================================================
  // 3. Validate ANTHROPIC_MODEL
  // ============================================================

  const model =
    process.env.ANTHROPIC_MODEL;

  if (!model) {
    console.error(`
❌ ANTHROPIC_MODEL is not configured.

For Anthropic API:
  ANTHROPIC_MODEL=claude-sonnet-4-5-20250929

For AWS Bedrock:
  ANTHROPIC_MODEL=us.anthropic.claude-sonnet-4-5-20250929-v1:0

Please add the appropriate model to your .env file.
`);

    process.exitCode = 1;
    return;
  }

  logger.info(
    `Using model: ${model}`
  );

  // ============================================================
  // 4. Display review information
  // ============================================================

  console.log('');
  console.log(
    '🔍 Claude Multi-Agent Code Review'
  );
  console.log(
    '================================='
  );
  console.log(
    `Repository: ${owner}/${repo}`
  );
  console.log(
    `Pull Request: #${prNumber}`
  );
  console.log('');

  const startTime =
    Date.now();

  try {
    // ==========================================================
    // 5. Create orchestrator
    // ==========================================================

    const orchestrator =
      new Orchestrator();

    // ==========================================================
    // 6. Execute code review
    // ==========================================================

    logger.info(
      'Starting pull request review',
      {
        owner,
        repo,
        prNumber
      }
    );

    const report =
      await orchestrator.reviewPullRequest(
        owner,
        repo,
        prNumber
      );

    // ==========================================================
    // 7. Generate reports
    // ==========================================================

    const reportGenerator =
      new ReportGenerator();

    const markdownReport =
      reportGenerator.generateMarkdownReport(
        report
      );

    const htmlReport =
      reportGenerator.generateHTMLReport(
        report
      );

    const jsonReport =
      reportGenerator.generateJSONReport(
        report
      );

    // ==========================================================
    // 8. Create PR-specific reports directory
    // ==========================================================

    const reportsDirectory =
      path.resolve('reports');

    await mkdir(
      reportsDirectory,
      {
        recursive: true
      }
    );

    // ==========================================================
    // 9. Generate filenames
    // ==========================================================

    const baseFilename =
      `${owner}_${repo}_${prNumber}`;

    const jsonPath =
      path.join(
        reportsDirectory,
        `${baseFilename}.json`
      );

    const markdownPath =
      path.join(
        reportsDirectory,
        `${baseFilename}.md`
      );

    const htmlPath =
      path.join(
        reportsDirectory,
        `${baseFilename}.html`
      );

    // ==========================================================
    // 10. Save reports
    // ==========================================================

    await Promise.all([
      writeFile(
        jsonPath,
        jsonReport,
        'utf8'
      ),

      writeFile(
        markdownPath,
        markdownReport,
        'utf8'
      ),

      writeFile(
        htmlPath,
        htmlReport,
        'utf8'
      )
    ]);

    // ==========================================================
    // 11. Display success information
    // ==========================================================

    const duration =
      Date.now() - startTime;

    console.log('');
    console.log(
      '✅ Code review completed successfully!'
    );
    console.log('');
    console.log(
      `📊 Review duration: ${duration}ms`
    );
    console.log('');
    console.log(
      '📁 Reports generated:'
    );
    console.log(
      `   JSON:     ${jsonPath}`
    );
    console.log(
      `   Markdown: ${markdownPath}`
    );
    console.log(
      `   HTML:     ${htmlPath}`
    );
    console.log('');

    logger.info(
      'Code review completed successfully',
      {
        owner,
        repo,
        prNumber,
        duration,
        reports: [
          jsonPath,
          markdownPath,
          htmlPath
        ]
      }
    );
  } catch (error: unknown) {
    // ==========================================================
    // 12. Graceful error handling
    // ==========================================================

    const formattedError =
      formatError(error);

    console.error('');
    console.error(
      '❌ Code review failed'
    );
    console.error('');
    console.error(
      formattedError
    );
    console.error('');

    if (isReviewError(error)) {
      logger.error(
        'Code review failed',
        {
          owner,
          repo,
          prNumber,
          errorCode: error.code,
          message: error.message,
          metadata: error.metadata
        }
      );

      switch (error.code) {
        case ErrorCodes.MISSING_API_KEY:
          console.error(
            'Check ANTHROPIC_API_KEY or AWS credentials.'
          );
          break;

        case ErrorCodes.MISSING_GITHUB_TOKEN:
          console.error(
            'Check GITHUB_TOKEN in your .env file.'
          );
          break;

        case ErrorCodes.PR_NOT_FOUND:
          console.error(
            'Check that the repository and PR number are correct.'
          );
          break;

        case ErrorCodes.RATE_LIMITED:
          console.error(
            'The API rate limit was reached. Please try again later.'
          );
          break;

        case ErrorCodes.AGENT_TIMEOUT:
          console.error(
            'A review agent timed out. Please try the review again.'
          );
          break;

        case ErrorCodes.STRUCTURED_OUTPUT_FAILED:
          console.error(
            'The model returned output that did not match the required review schema.'
          );
          break;

        case ErrorCodes.RETRY_EXHAUSTED:
          console.error(
            'The operation failed after all retry attempts.'
          );
          break;

        default:
          console.error(
            'Check the logs for additional details.'
          );
      }
    } else {
      logger.error(
        'Unexpected code review failure',
        {
          owner,
          repo,
          prNumber,
          error:
            error instanceof Error
              ? error.message
              : String(error)
        }
      );
    }

    process.exitCode = 1;
  }
}

// ============================================================
// Run the CLI
// ============================================================

main().catch(
  (error: unknown) => {
    console.error(
      '❌ Fatal error:',
      formatError(error)
    );

    process.exitCode = 1;
  }
);