import { Msg } from './ContextManager';

export const SUMMARIZE_PROMPT = (runningSummary: string, newTurns: Msg[]) => [
  { role: "system", content:
`You are a razor-concise meeting clerk.
Update the running "Session summary" with only durable decisions, constraints, and intermediate results.
Keep ≤ 450 tokens. Use bullet points + short headers. Omit chit-chat.` },
  { role: "user", content:
`Current session summary (may be empty):
---
${runningSummary || "(none)"}

New conversation to incorporate:
---
${newTurns.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n")}

Return ONLY the updated summary.` }
];

export const FACTS_PROMPT = (newTurns: Msg[]) => [
  { role: "system", content:
`Extract stable, reusable FACTS as key:value lines.
Only include items likely valid in future turns (IDs, URLs, API keys masked, file paths, user prefs, model choices).
Return JSON array of {key, value}. Max 25 facts. No duplicates.` },
  { role: "user", content:
newTurns.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n") }
];

export const safeParseFacts = (s: string) => { 
  try { 
    return JSON.parse(s); 
  } catch { 
    return []; 
  } 
};
