// Клиент ИИ-аналитики на GLM (z.ai) через Anthropic-совместимый
// Messages API: {GLM_BASE_URL}/v1/messages, ответ content[].text.
// Просит модель собрать по интернету причины движения монет за период.
import { GLM_API_KEY, GLM_MODEL, GLM_BASE_URL } from './config.js';

const REQUEST_TIMEOUT_MS = 120_000; // web_search может быть небыстрым

async function createMessage({ system, prompt, tools, signal }) {
  const res = await fetch(`${GLM_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      // оба варианта авторизации: x-api-key и Bearer (z.ai принимает и то, и то)
      'x-api-key': GLM_API_KEY,
      Authorization: `Bearer ${GLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: GLM_MODEL,
      max_tokens: 4096,
      temperature: 0.6,
      system,
      messages: [{ role: 'user', content: prompt }],
      ...(tools && { tools }),
    }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`GLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  return {
    text,
    usage: { in: data.usage?.input_tokens ?? 0, out: data.usage?.output_tokens ?? 0 },
  };
}

// Анализ корзины: prompt собирает сервер (период + статистика монет).
// Возвращает { text, usage: { in, out } } — токены идут в учёт админ-раздела.
export async function analyzeBasket(prompt) {
  if (!GLM_API_KEY) {
    const err = new Error('ИИ-аналитика отключена: не задан GLM_API_KEY');
    err.status = 503;
    throw err;
  }

  const system =
    'Ты — аналитик криптовалютного рынка. Отвечай по-русски, структурировано и по делу ' +
    '(заголовки, короткие списки), без воды. Приводи факты из поиска с датами, где возможно. ' +
    'Объём ответа: до ~450 слов. Не давай финансовых советов, анализируй причины движения цен.';

  // Встроенный веб-поиск в формате Anthropic server tool; если эндпоинт его
  // не принимает (400) — один ретрай без инструментов.
  const webSearch = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    try {
      return await createMessage({ system, prompt, tools: webSearch, signal: controller.signal });
    } catch (err) {
      if (err.status === 400) {
        return await createMessage({ system, prompt, signal: controller.signal });
      }
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}
