// Cloudflare Worker — прокси к OpenRouter, прячет ключ.
// Секрет: OPENROUTER_API_KEY  (wrangler secret put OPENROUTER_API_KEY)
// Опционально переменная ALLOWED_ORIGIN — origin твоего сайта (иначе '*').

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return new Response('POST only', { status: 405, headers: cors });

    const body = await req.text(); // тело собирает клиент (model, messages, response_format…)
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': origin === '*' ? 'https://zavhoz.local' : origin,
        'X-Title': 'Zavhoz Ladoga',
      },
      body,
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  },
};
