// Per-request display telemetry. Estimates never alter generation/context settings.
export function trackStreamProgress(onDelta, { messages = [], tools, now = Date.now } = {}) {
  if (typeof onDelta !== 'function') return Object.assign(() => {}, { finish() {} });
  let promptChars = 0;
  for (const message of messages) {
    promptChars += 16; // approximate message framing
    if (typeof message.content === 'string') promptChars += message.content.length;
    else for (const part of message.content ?? []) {
      if (typeof part.text === 'string') promptChars += part.text.length;
      else if (part.type === 'image_url') promptChars += 4096; // rough vision allowance, not base64 length
    }
    if (message.tool_calls) promptChars += JSON.stringify(message.tool_calls).length;
  }
  const promptEstimate = Math.ceil((promptChars + (tools ? JSON.stringify(tools).length : 0)) / 4);
  let chars = 0;
  let lastReport = -Infinity;
  let measured = null;
  const report = (text = '', meta = {}) => {
    chars += String(text).length + String(meta.reasoning ?? '').length + String(meta.toolFrag?.args ?? '').length;
    if (meta.timings) measured = meta.timings;
    const time = now();
    if (meta.final || time - lastReport >= 500) {
      lastReport = time;
      const timings = meta.timings ?? {
        prompt_n: measured?.prompt_n ?? promptEstimate,
        predicted_n: Math.max(measured?.predicted_n ?? 0, Math.ceil(chars / 4)),
        predicted_per_second: null,
        estimated: true,
      };
      onDelta?.(text, { ...meta, timings });
    } else {
      const { timings: ignored, ...delta } = meta;
      onDelta?.(text, delta);
    }
  };
  report.finish = usage => {
    if (Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens)) {
      report('', { final: true, timings: { prompt_n: usage.prompt_tokens, predicted_n: usage.completion_tokens, predicted_per_second: null, estimated: false } });
    }
  };
  return report;
}
