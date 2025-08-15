import { ContextManager, Msg } from './ContextManager';
import { SUMMARIZE_PROMPT, FACTS_PROMPT, safeParseFacts } from './context-prompts';
import { openai } from '@ai-sdk/openai';

// Example of how to integrate ContextManager with your existing agent
export class ContextAwareAgent {
    private contextManager: ContextManager;
    
    constructor(systemPrompt: string) {
        this.contextManager = new ContextManager([
            { role: "system", content: systemPrompt }
        ]);
    }
    
    /**
     * Process a user message with context management
     */
    async processMessage(userText: string): Promise<string> {
        const userMsg: Msg = { role: "user", content: userText };
        
        // 1) Build prompt with budget for the "final" step
        const { messages, approxTokens } = this.contextManager.buildPrompt(userMsg, { 
            maxInputTokens: 3500, 
            keepTurns: 4 
        });
        
        console.log(`Context built with ~${approxTokens} tokens`);
        
        // 2) Get response from your existing agent logic here
        // This is where you'd integrate with your Mastra agent
        const response = "This is a placeholder response. Replace with your agent's actual response.";
        
        // 3) Record the turn for context management
        this.contextManager.addTurn([userMsg, { role: "assistant", content: response }]);
        
        // 4) Background compaction (immediately, cheap with 4.1-mini)
        const newTurns = [
            { role: "user", content: userText }, 
            { role: "assistant", content: response }
        ];
        
        // Update session summary
        try {
            const summaryResp = await openai('gpt-4.1-mini').generateText({
                messages: SUMMARIZE_PROMPT(this.contextManager.getCurrentSummary(), newTurns),
                maxTokens: 300
            });
            this.contextManager.setSessionSummary(summaryResp.text || "");
        } catch (error) {
            console.warn('Summary update failed:', error);
        }
        
        // Extract facts
        try {
            const factsResp = await openai('gpt-4.1-mini').generateText({
                messages: FACTS_PROMPT(newTurns),
                maxTokens: 250
            });
            const facts = safeParseFacts(factsResp.text || "[]");
            this.contextManager.upsertFacts(facts);
            this.contextManager.cleanupFacts(80);
        } catch (error) {
            console.warn('Facts extraction failed:', error);
        }
        
        return response;
    }
    
    /**
     * Get current context information
     */
    getContextInfo() {
        return {
            sessionSummary: this.contextManager.getCurrentSummary(),
            facts: this.contextManager.getCurrentFacts(),
            factsAsBullets: this.contextManager.getFactsAsBulletList()
        };
    }
    
    /**
     * Add tool output to context (useful for your existing tools)
     */
    addToolOutput(toolName: string, output: string) {
        const toolDigest = ContextManager.makeToolDigest(toolName, output);
        this.contextManager.addTurn([toolDigest]);
    }
}

// Usage example:
/*
const agent = new ContextAwareAgent("You are a helpful coding assistant...");

// Process messages
const response = await agent.processMessage("Create a React component");

// Add tool outputs
agent.addToolOutput("fileWriter", "Created component.tsx successfully");

// Get context info
const context = agent.getContextInfo();
console.log("Session summary:", context.sessionSummary);
console.log("Key facts:", context.factsAsBullets);
*/
