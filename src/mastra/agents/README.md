# Lightweight Buffer System for Coding Agent

This implementation provides a memory-efficient context management system for your Mastra coding agent, using three lightweight buffers to maintain conversation context without accumulating tokens.

## Architecture

### 1. Static Prefix (Cached)
- **Purpose**: System prompt + invariant rules/examples (identical across calls)
- **Storage**: Loaded once, never changes
- **Token Cost**: ~500-800 tokens (one-time)

### 2. Short-term Window
- **Purpose**: Last 2-4 user/assistant turns verbatim (for local coherence)
- **Storage**: Rolling window of recent messages
- **Token Cost**: ~200-400 tokens per turn
- **Management**: Automatically capped at 6 messages (≈3 turns)

### 3. Compacted Session Summary
- **Purpose**: ~300-600 tokens that capture facts/decisions/constraints
- **Storage**: Continuously updated and compressed
- **Token Cost**: ~300-600 tokens
- **Management**: Refreshed after each turn using GPT-4.1-mini

### 4. Long-term Facts Store
- **Purpose**: 1-2 line bullets (name:value) extracted from session
- **Storage**: Key-value pairs outside running summary
- **Token Cost**: ~100-200 tokens
- **Management**: Capped at 80 facts, auto-cleanup

## Files

- `ContextManager.ts` - Core context management class
- `context-prompts.ts` - Summarization and fact extraction prompts
- `context-aware-agent.ts` - Integration example with your existing agent
- `context-integration-example.ts` - Simple usage example

## Usage

### Basic Integration

```typescript
import { ContextManager } from './ContextManager';

// Initialize with your system prompt
const contextManager = new ContextManager([
    { role: "system", content: "You are a helpful coding assistant..." }
]);

// Process a user message
const userMsg = { role: "user", content: "Create a React component" };
const { messages, approxTokens } = contextManager.buildPrompt(userMsg, {
    maxInputTokens: 3500,
    keepTurns: 4
});

console.log(`Context built with ~${approxTokens} tokens`);
// Use messages with your LLM call
```

### With Your Existing Agent

```typescript
import { ContextAwareAgent } from './context-integration-example';

const agent = new ContextAwareAgent("You are a helpful coding assistant...");

// Process messages with automatic context management
const response = await agent.processMessage("Create a React component");

// Add tool outputs to context
agent.addToolOutput("fileWriter", "Created component.tsx successfully");

// Get current context info
const context = agent.getContextInfo();
console.log("Session summary:", context.sessionSummary);
console.log("Key facts:", context.factsAsBullets);
```

## Token Budgets

### Input Budgets
- **Routine/tool steps**: ~3.5k tokens
- **Final answer**: ~6-8k tokens max
- **Window size**: ≤ 3 turns (6 messages)

### Output Budgets
- **Tool steps**: ≤128-256 tokens
- **Final answer**: ≤900-1200 tokens

### Management
- **Window trimming**: Drop turns first when over budget
- **Summary compression**: Re-summarize to smaller targets if needed
- **Facts cleanup**: Auto-evict oldest facts beyond 80 limit

## Algorithm (Per Turn)

### After Each Model Reply
1. **Update session summary** using GPT-4.1-mini (128-256 max tokens)
2. **Extract/update long-term facts** (key:value bullets)
3. **Compress tool outputs** into short digests

### Before Each New Call
1. **Build prompt**: staticPrefix + longTermFacts + sessionSummary + lastNTurns
2. **Enforce token budget** using tokenizer
3. **Shrink if over budget**: lastNTurns → sessionSummary → add system nudge

## Benefits

- **Memory Efficient**: Maintains context without token accumulation
- **Cost Effective**: Uses cheaper GPT-4.1-mini for summarization
- **Intelligent Compression**: Preserves important information while dropping chit-chat
- **Automatic Management**: Self-maintaining with configurable limits
- **Tool Integration**: Automatically digests tool outputs for future reference

## Configuration

```typescript
// Customize token budgets
const { messages } = contextManager.buildPrompt(userMsg, {
    maxInputTokens: 4000,  // Increase for complex tasks
    keepTurns: 6           // Keep more recent context
});

// Customize fact limits
contextManager.cleanupFacts(100);  // Allow more facts

// Customize tool digest size
const toolDigest = ContextManager.makeToolDigest(
    "fileWriter", 
    longOutput, 
    1200  // Increase max chars
);
```

## Integration Points

1. **Replace your existing agent's memory system** with ContextManager
2. **Add context management calls** after each user interaction
3. **Integrate tool output digestion** into your existing tool execution
4. **Use the built prompt** instead of manually constructing messages

This system provides the same context awareness as traditional approaches but with significantly lower token costs and better long-term memory management.
