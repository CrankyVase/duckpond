// Build a bounded transcript without dropping the decisions nearest the live turn.
// Keep the opening context and spend the rest of the budget on recent messages.
export const COMPACT_PROMPT = `Write a context brief so an assistant can continue this conversation without restarting the task. Preserve the user's current goal, explicit constraints, decisions, exact paths and identifiers, work already done, test results, open errors, and the next action. Distinguish completed work from plans. Prefer the user's latest corrections when instructions conflict. Use concise headings: Goal, Constraints, Decisions, Work done, Open items, Next action. Do not invent missing details.`;

function messageText(message) {
  if (typeof message.content === 'string') return message.content;
  return JSON.stringify(message.content ?? '');
}

export function compactTranscript(messages, maxChars = 60_000) {
  const entries = messages.map((message) => {
    const content = messageText(message);
    // Keep a little of the opening and the end of oversized turns. The end
    // commonly contains the decision, error, or final test result.
    const clipped = content.length > 6_000
      ? `${content.slice(0, 1_500)}\n[earlier part of this message omitted]\n${content.slice(-4_000)}`
      : content;
    return `${message.role.toUpperCase()}: ${clipped}`;
  });
  if (entries.join('\n\n').length <= maxChars) return entries.join('\n\n');

  const head = [];
  let headSize = 0;
  let firstTail = 0;
  while (firstTail < Math.min(entries.length, 4) && headSize + entries[firstTail].length < maxChars * 0.2) {
    head.push(entries[firstTail]);
    headSize += entries[firstTail].length + 2;
    firstTail += 1;
  }
  const tail = [];
  let tailSize = 0;
  for (let i = entries.length - 1; i >= firstTail; i -= 1) {
    const cost = entries[i].length + 2;
    if (headSize + tailSize + cost > maxChars - 120) break;
    tail.unshift(entries[i]);
    tailSize += cost;
  }
  const omitted = entries.length - head.length - tail.length;
  return [...head, `[${omitted} older message(s) omitted to fit the compaction budget]`, ...tail].join('\n\n');
}
