import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk';

import {
  REFACTORING_SUGGESTER_PROMPT
} from '../prompts/refactoring-suggester.prompt.js';

export const refactoringSuggester: AgentDefinition = {
  description:
    'Identifies concrete refactoring opportunities for readability, maintainability, duplication, and design quality.',

  tools: [
    'Read',
    'Grep',
    'Glob',
    'Skill',
    'mcp__github__*'
  ],

  model: 'inherit',

  prompt: REFACTORING_SUGGESTER_PROMPT
};
