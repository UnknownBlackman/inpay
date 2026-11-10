// Optional: if LLM_BASE_URL, LLM_API_KEY and LLM_MODEL are set (any OpenAI-compatible API,
// e.g. NEAR AI Cloud), reword log lines and customer messages in friendlier words.
// Never used for decisions. Everything works without it.
const { LLM_BASE_URL, LLM_API_KEY, LLM_MODEL } = process.env;
export const llmEnabled = Boolean(LLM_BASE_URL && LLM_API_KEY && LLM_MODEL && process.env.OFFLINE !== '1');

export async function rewrite(text: string): Promise<string | undefined> {
  if (!llmEnabled) return undefined;
  try {
    const res = await fetch(`${LLM_BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_API_KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        max_tokens: 120,
        messages: [
          { role: 'system', content: 'Rewrite the payment log line in one short, friendly, plain-English sentence for a small merchant. Keep every number, amount, currency and name exactly as given. No emojis.' },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!res.ok) return undefined;
    const j: any = await res.json();
    return j?.choices?.[0]?.message?.content?.trim() || undefined;
  } catch {
    return undefined;
  }
}
