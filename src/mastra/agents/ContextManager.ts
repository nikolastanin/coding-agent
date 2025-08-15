// npm i @dqbd/tiktoken
import { encoding_for_model } from "@dqbd/tiktoken";

export type Msg = { role: "system" | "user" | "assistant" | "tool"; content: string };
export type Fact = { key: string; value: string; source?: string; updatedAt: string };

export class ContextManager {
  private enc = encoding_for_model("gpt-4.1");
  private staticPrefix: Msg[];
  private window: Msg[] = [];           // recent raw turns
  private sessionSummary = "";          // compact narrative
  private facts: Record<string, Fact> = {};

  constructor(staticPrefix: Msg[]) {
    this.staticPrefix = staticPrefix;
  }

  /** Call after each visible turn (user + assistant + tool digests) */
  addTurn(messages: Msg[]) {
    this.window.push(...messages);
    // cap window to last 6 messages (≈3 turns)
    this.window = this.window.slice(-6);
  }

  /** Replace long tool blobs with a digest before addTurn */
  static makeToolDigest(name: string, raw: string, maxChars = 800): Msg {
    const trimmed = raw.length > maxChars ? raw.slice(0, maxChars) + " ...[truncated]" : raw;
    return { role: "tool", content: `TOOL=${name}\nSUMMARY:\n${trimmed}` };
  }

  /** Update the compact session summary (call model outside, then set here) */
  setSessionSummary(summary: string) {
    this.sessionSummary = summary;
  }

  /** Merge key facts (idempotent) */
  upsertFacts(newFacts: Fact[]) {
    for (const f of newFacts) {
      this.facts[f.key.toLowerCase()] = { ...f, updatedAt: new Date().toISOString() };
    }
  }

  getFactsAsBulletList(max = 30) {
    const items = Object.values(this.facts)
      .sort((a,b) => (a.key > b.key ? 1 : -1))
      .slice(0, max)
      .map(f => `- ${f.key}: ${f.value}`);
    return items.join("\n");
  }

  /** Build the prompt under a token budget */
  buildPrompt(userMsg: Msg, {
    maxInputTokens = 3500, keepTurns = 4
  }: { maxInputTokens?: number; keepTurns?: number } = {}) {

    const factsBlock = this.getFactsAsBulletList();
    const summaryMsg: Msg = this.sessionSummary
      ? { role: "system", content: `Session summary (compact):\n${this.sessionSummary}` }
      : null as any;

    const base: Msg[] = [
      ...this.staticPrefix,
      ...(summaryMsg ? [summaryMsg] : []),
      ...(factsBlock ? [{ role: "system", content: `Key facts:\n${factsBlock}` } as Msg] : []),
      ...this.window.slice(-keepTurns),
      userMsg
    ];

    // If over budget, shrink: drop window turns first, then tighten summary hint
    let prompt = base;
    let tokens = this.countTokens(prompt);

    // Step 1: trim window turns
    let k = keepTurns;
    while (tokens > maxInputTokens && k > 0) {
      k -= 2; // drop one full turn (user+assistant)
      prompt = [
        ...this.staticPrefix,
        ...(summaryMsg ? [summaryMsg] : []),
        ...(factsBlock ? [{ role: "system", content: `Key facts:\n${factsBlock}` } as Msg] : []),
        ...this.window.slice(-Math.max(0, k)),
        userMsg
      ];
      tokens = this.countTokens(prompt);
    }

    // Step 2: annotate for further tightening on the model side
    if (tokens > maxInputTokens) {
      // Add a system nudge asking the model to rely on summary
      prompt = [
        ...this.staticPrefix,
        { role: "system", content: "Context trimmed for token budget. Rely on 'Session summary' + 'Key facts' above." },
        ...(summaryMsg ? [summaryMsg] : []),
        ...(factsBlock ? [{ role: "system", content: `Key facts:\n${factsBlock}` } as Msg] : []),
        userMsg
      ];
    }

    return { messages: prompt, approxTokens: tokens };
  }

  countTokens(messages: Msg[]) {
    const text = JSON.stringify(messages);
    const n = this.enc.encode(text).length;
    return n;
  }

  /** Get current session summary for external summarization */
  getCurrentSummary(): string {
    return this.sessionSummary;
  }

  /** Get current facts for external fact extraction */
  getCurrentFacts(): Fact[] {
    return Object.values(this.facts);
  }

  /** Clear old facts to prevent accumulation */
  cleanupFacts(maxFacts = 80) {
    const factEntries = Object.entries(this.facts);
    if (factEntries.length > maxFacts) {
      // Sort by update time and keep the most recent
      const sorted = factEntries.sort((a, b) => 
        new Date(b[1].updatedAt).getTime() - new Date(a[1].updatedAt).getTime()
      );
      
      // Keep only the most recent facts
      const toKeep = sorted.slice(0, maxFacts);
      this.facts = Object.fromEntries(toKeep);
    }
  }
}
