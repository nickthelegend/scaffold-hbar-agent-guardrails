import { betaStandardSchemaTool } from "@anthropic-ai/sdk/helpers/beta/standard-schema";
import { HederaAgentAPI, ToolDiscovery, type Configuration } from "@hashgraph/hedera-agent-kit";
import type { Client } from "@hiero-ledger/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Minimal Hedera Agent Kit adapter for the Anthropic SDK's tool runner.
 *
 * Agent Kit tools carry a Zod v3 schema and an `execute`. Zod v3 implements Standard Schema, so each tool becomes a
 * `betaStandardSchemaTool` (the SDK validates Claude's input against it) with its JSON Schema derived by
 * zod-to-json-schema. Calls dispatch through `HederaAgentAPI.run`, so Agent Kit hooks and policies still apply.
 */
export class ClaudeHederaToolkit {
  readonly api: HederaAgentAPI;

  constructor({ client, configuration }: { client: Client; configuration: Configuration }) {
    const context = configuration.context ?? {};
    const tools = ToolDiscovery.createFromConfiguration(configuration).getAllTools(context, configuration);
    this.api = new HederaAgentAPI(client, context, tools);
  }

  /** Runs a tool directly (no LLM) and returns its parsed `{ raw, humanMessage }` envelope. */
  async run(method: string, args: unknown): Promise<{ raw: Record<string, unknown>; humanMessage: string }> {
    return JSON.parse(await this.api.run(method, args));
  }

  getTools() {
    return this.api.tools.map(tool =>
      betaStandardSchemaTool({
        name: tool.method,
        description: tool.description,
        inputSchema: tool.parameters,
        jsonSchema: zodToJsonSchema(tool.parameters, {
          target: "jsonSchema7",
          $refStrategy: "none",
        }) as Record<string, unknown>,
        run: async input => this.api.run(tool.method, input),
      }),
    );
  }
}
