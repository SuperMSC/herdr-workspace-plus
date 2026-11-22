// Local list prices for estimating what recorded agent usage would cost at API rates.
// Not a bill: subscription plans are charged differently. Update PRICING_DATE with the table.
// USD per million tokens. Claude: platform.claude.com pricing; OpenAI: developers.openai.com pricing.
export const PRICING_DATE = "2026-11-22";

const claude = (input, output, cacheRead, write5m = input * 1.25, write1h = input * 2, extra = {}) => ({ input, output, cacheRead, write5m, write1h, ...extra });
const openai = (input, cacheRead, output, write, long = null) => ({ input, output, cacheRead, write5m: write, write1h: write, ...(long ? { long } : {}) });

// Longest prefix wins, so "claude-opus-5-5" is matched before "claude-opus-5".
export const PRICES = {
  claude: {
    "claude-fable-5-2": claude(8, 40, 0.2, 10, 16),
    "claude-mythos-5-2": claude(8, 40, 0.2, 10, 16),
    "claude-fable-5-1": claude(10, 50, 0.25, 12.5, 20),
    "claude-mythos-5-1": claude(10, 50, 0.25, 12.5, 20),
    "claude-fable-5": claude(10, 50, 1, 12.5, 20),
    "claude-mythos-5": claude(10, 50, 1, 12.5, 20),
    "claude-opus-5-5": claude(4, 20, 0.2, 5, 8),
    "claude-opus-5": claude(5, 25, 0.5),
    "claude-opus-4-8": claude(5, 25, 0.5),
    "claude-opus-4-7": claude(5, 25, 0.5),
    "claude-opus-4-6": claude(5, 25, 0.5),
    "claude-opus-4-5": claude(5, 25, 0.5),
    "claude-opus-4-1": claude(15, 75, 1.5),
    "claude-opus-4": claude(15, 75, 1.5),
    "claude-sonnet-5-5": claude(2, 10, 0.1, 2.5, 4),
    "claude-sonnet-5": claude(2, 10, 0.2, 2.5, 4),
    "claude-sonnet-4-6": claude(3, 15, 0.3),
    "claude-sonnet-4-5": claude(3, 15, 0.3),
    "claude-sonnet-4": claude(3, 15, 0.3),
    // Prompts over 100K tokens use the second rate card.
    "claude-haiku-5-5": claude(0.1, 0.5, 0.01, 0.125, 0.2, { long: { threshold: 100000, ...claude(0.5, 2.5, 0.05) } }),
    "claude-haiku-4-5": claude(1, 5, 0.1),
  },
  codex: {
    // Requests over 272K input tokens are billed at the long-context rates for the whole request.
    "gpt-6.2-astra": openai(8, 0.4, 40, 10, { threshold: 272000, input: 16, cacheRead: 0.8, output: 60, write5m: 20, write1h: 20 }),
    "gpt-6.2-sol": openai(2, 0.1, 10, 2.5, { threshold: 272000, input: 4, cacheRead: 0.2, output: 15, write5m: 5, write1h: 5 }),
    "gpt-6.1-sol": openai(2, 0.1, 10, 2.5, { threshold: 272000, input: 4, cacheRead: 0.2, output: 15, write5m: 5, write1h: 5 }),
    "gpt-6.1-terra": openai(1, 0.05, 5, 1.25),
    "gpt-6-astra": openai(10, 1, 50, 12.5, { threshold: 272000, input: 20, cacheRead: 2, output: 75, write5m: 25, write1h: 25 }),
    "gpt-6-sol": openai(2, 0.2, 10, 2.5, { threshold: 272000, input: 4, cacheRead: 0.4, output: 15, write5m: 5, write1h: 5 }),
    "gpt-6-luna": openai(0.1, 0.01, 0.5, 0.125, { threshold: 272000, input: 0.2, cacheRead: 0.02, output: 0.75, write5m: 0.25, write1h: 0.25 }),
    "gpt-5.3-codex": openai(1.75, 0.175, 14, 2.1875),
  },
};

// Fast mode (Claude `speed: "fast"`) and Codex's priority tier are billed at twice the standard rate.
export const FAST_MULTIPLIER = 2;

export function normalizeModel(model) {
  return String(model ?? "").trim().toLowerCase().replace(/\[[^\]]*\]$/, "").replace(/^(anthropic\.|openai\/)/, "").replace(/-\d{8}$/, "").replace(/@\d{8}$/, "");
}

const sorted = Object.fromEntries(Object.entries(PRICES).map(([provider, table]) => [provider, Object.keys(table).sort((a, b) => b.length - a.length)]));
export function priceFor(provider, model) {
  const name = normalizeModel(model), table = PRICES[provider];
  if (!table || !name) return null;
  const key = sorted[provider].find(key => name === key || name.startsWith(key + "-"));
  return key ? { key, ...table[key] } : null;
}

/** Event: { i: uncached input, o: output, r: cache read, w5, w1: cache writes, f: fast/priority, p: prompt size }. */
export function eventCost(provider, event) {
  const price = priceFor(provider, event.m);
  if (!price) return null;
  const prompt = Number.isFinite(event.p) ? event.p : (event.i || 0) + (event.r || 0) + (event.w5 || 0) + (event.w1 || 0);
  const rate = price.long && prompt > price.long.threshold ? price.long : price;
  const usd = ((event.i || 0) * rate.input + (event.o || 0) * rate.output + (event.r || 0) * rate.cacheRead + (event.w5 || 0) * rate.write5m + (event.w1 || 0) * rate.write1h) / 1e6;
  return usd * (event.f ? FAST_MULTIPLIER : 1);
}
