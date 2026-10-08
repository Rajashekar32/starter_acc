import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import {
  CODE_QUALITY_ANALYZER_PROMPT
} from '../prompts/code-quality-analyzer.prompt.js';

export const codeQualityAnalyzer: AgentDefinition = {
  description:
    'Analyzes changed code for correctness, security, performance, maintainability, and code quality issues.',

  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    'mcp__github__*'
  ],

  model: 'inherit',

  prompt: CODE_QUALITY_ANALYZER_PROMPT
};
