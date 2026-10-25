'use strict';

// A language model for the UI tests (test/ui): canned answers, streamed in small pieces.
const vscode = require('vscode');

const COMMIT = 'Tighten the view spacing\n\nUse the theme spacing on narrow widths.';
// Markup in the answer must reach the page as text (the summary page renders no HTML).
const SUMMARY = '## What changed\nThe agent edited `agent.txt`. <img src=x onerror="document.title=\'pwned\'">\n\n## Looks risky\n- Nothing stands out.\n\n## Review first\n1. `agent.txt`';

exports.activate = (context) => {
  context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('cc-test', {
    async provideLanguageModelChatInformation() {
      return [{ id: 'cc-test-1', name: 'Test LM', family: 'cc-test', version: '1', maxInputTokens: 32000, maxOutputTokens: 2000, capabilities: {} }];
    },
    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      const prompt = messages.map((m) => m.content.map((p) => p.value || '').join('')).join('\n');
      const reply = /Write a git commit message/.test(prompt) ? COMMIT : SUMMARY;
      for (const chunk of reply.match(/[\s\S]{1,8}/g)) {
        if (token.isCancellationRequested) return;
        progress.report(new vscode.LanguageModelTextPart(chunk));
        await new Promise((r) => setTimeout(r, 10));
      }
    },
    async provideTokenCount(model, text) {
      return Math.ceil(String(typeof text === 'string' ? text : JSON.stringify(text)).length / 4);
    },
  }));
};

exports.COMMIT = COMMIT;
