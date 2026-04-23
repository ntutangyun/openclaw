export const SELF_HOSTED_DEFAULT_CONTEXT_WINDOW = 128000;
// Reasoning-capable self-hosted models (ollama/gemma4, qwen3, etc.) share a
// single per-response budget across `thinking`, visible text, and tool-call
// JSON. 8192 tokens is often exhausted by thinking alone on a 25k+ prompt,
// which surfaces to the harness as an "empty response" and derails the
// agent loop. 16384 doubles the headroom; the provider's `options.num_predict`
// is the only effect, and output tokens on self-hosted runs are free.
export const SELF_HOSTED_DEFAULT_MAX_TOKENS = 16384;
export const SELF_HOSTED_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
