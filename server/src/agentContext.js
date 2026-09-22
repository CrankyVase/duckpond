// Account for new tool output before dispatch, with provider usage as calibration.
// Estimates remain estimates: retain the provider overflow recovery path.
import { estimateTokens } from './contextsaver.js';

export function estimateAgentPrompt(messages, tools = []) {
  const images = messages.flatMap(m => Array.isArray(m.content) ? m.content : [])
    .filter(p => p.type === 'image_url').length;
  return estimateTokens(messages) + Math.ceil(JSON.stringify(tools).length / 4)
    + messages.length * 8 + images * 2048;
}

export function agentInputLimit(contextWindow, outputTokens = 4096) {
  if (!(contextWindow > 0)) return Infinity;
  const reserve = Math.min(Number(outputTokens) > 0 ? Number(outputTokens) : 4096, contextWindow / 2);
  const margin = Math.min(1024, Math.ceil(contextWindow * 0.05));
  return Math.max(1, Math.floor(contextWindow - reserve - margin));
}

export function calibratedPromptEstimate(estimate, previousEstimate, previousUsage) {
  if (!(previousEstimate > 0) || !(previousUsage > 0)) return estimate;
  // Never reduce the estimate based on an optimistic tokenizer ratio.
  return Math.ceil(estimate * Math.max(1, previousUsage / previousEstimate));
}

export function trimAgentToolHistory(messages, keep = 8) {
  const indices = messages.flatMap((m, i) => m.role === 'tool' ? [i] : []);
  for (const i of indices.slice(0, Math.max(0, indices.length - keep))) {
    const content = messages[i].content;
    if (typeof content === 'string' && content.length > 1400) {
      // Compiler errors and exit status often live at the END of shell output.
      messages[i] = { ...messages[i], content: content.slice(0, 600)
        + '\n[older output trimmed; beginning and end retained]\n' + content.slice(-600) };
    }
  }
}
