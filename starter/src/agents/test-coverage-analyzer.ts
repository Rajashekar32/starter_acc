import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import {
  TEST_COVERAGE_ANALYZER_PROMPT
} from '../prompts/test-coverage-analyzer.prompt.js';

export const testCoverageAnalyzer: AgentDefinition = {
  description:
    'Analyzes changed code for missing tests, weak coverage, and high-priority testing opportunities.',

  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    'mcp__github__*'
  ],

  model: 'inherit',

  prompt: TEST_COVERAGE_ANALYZER_PROMPT
};
