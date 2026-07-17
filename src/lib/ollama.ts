export interface OllamaStatus {
  reachable: boolean;
  models: string[];
  error?: string;
}

/** Probe the local Ollama server and list installed models. */
export async function checkOllama(baseUrl: string): Promise<OllamaStatus> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { reachable: false, models: [], error: `Ollama responded with HTTP ${res.status}.` };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { reachable: true, models: (data.models ?? []).map((m) => m.name) };
  } catch {
    return {
      reachable: false,
      models: [],
      error: 'Could not reach Ollama. Is it running? If you opened Scrivano from a website (not localhost), start Ollama with OLLAMA_ORIGINS set — see the README.',
    };
  }
}

/** Non-streaming generation against a local Ollama model. */
export async function generate(baseUrl: string, model: string, prompt: string): Promise<string> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.2 } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama error (HTTP ${res.status}): ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}
