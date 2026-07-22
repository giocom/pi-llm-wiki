/**
 * pi-llm-wiki v0.2 — LLM helper.
 *
 * Wraps Pi's AI layer so the rest of the extension doesn't have to know
 * about `complete` / `getApiKeyAndHeaders`. The caller passes the
 * `ExtensionContext` and we use `ctx.model` as the current model.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete, type Model, type Message } from "@earendil-works/pi-ai/compat";

export interface LlmRequest {
  systemPrompt?: string;
  userPrompt: string;
}

export interface LlmResult {
  text: string;
  modelId: string;
}

/**
 * Resolve a model + API key from the Pi context, then call `complete`.
 * Default model: `ctx.model` (whatever Pi is currently running with).
 */
export async function callLlm(
  ctx: ExtensionContext,
  request: LlmRequest,
): Promise<LlmResult> {
  const model: Model<any> | undefined = ctx.model;
  if (!model) {
    throw new Error(
      "No model is set in this Pi session. Start Pi with a model or pass one in.",
    );
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Auth failed: ${auth.error}`);
  }
  if (!auth.apiKey) {
    throw new Error(`No API key for model ${model.provider}/${model.id}`);
  }

  const messages: Message[] = [];
  if (request.systemPrompt) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: request.systemPrompt }],
      timestamp: Date.now(),
    } as Message);
  }
  messages.push({
    role: "user",
    content: [{ type: "text", text: request.userPrompt }],
    timestamp: Date.now(),
  } as Message);

  const response = await complete(model, { messages }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    env: auth.env,
  });

  const text = response.content
    .filter((c: { type: string }) => c.type === "text")
    .map((c: { type: string; text?: string }) => c.text ?? "")
    .join("\n")
    .trim();

  return { text, modelId: `${model.provider}/${model.id}` };
}
