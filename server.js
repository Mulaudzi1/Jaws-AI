import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4.1-mini';
const ULTRATHINK_PASSES = Number(process.env.ULTRATHINK_PASSES || 2);
const QUALITY_TARGET = Number(process.env.JAWS_QUALITY_TARGET || 94);
const REQUEST_TIMEOUT_MS = Number(process.env.JAWS_REQUEST_TIMEOUT_MS || 30000);
const SESSION_TURN_WINDOW = Number(process.env.JAWS_SESSION_TURN_WINDOW || 40);
const SESSION_COMPACT_TO = Number(process.env.JAWS_SESSION_COMPACT_TO || 20);
const sessionStore = new Map();
const responseCache = new Map();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error('Body too large'));
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(pathname, res) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const filePath = join(process.cwd(), safePath.replace(/^\/+/, ''));

  try {
    const content = await readFile(filePath);
    const type = MIME_TYPES[extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

function getCacheKey({ model, mode, thinkLevel, profile, message }) {
  return [model, mode, thinkLevel, profile, message].join('|').toLowerCase();
}

function getSessionState(sessionId) {
  if (!sessionId) return { turns: [], summary: '' };
  return sessionStore.get(sessionId) || { turns: [], summary: '' };
}

function storeSessionTurns(sessionId, turns) {
  if (!sessionId || !turns?.length) return;
  const current = getSessionState(sessionId);
  const mergedTurns = [...current.turns, ...turns];
  let summary = current.summary || '';

  if (mergedTurns.length > SESSION_TURN_WINDOW) {
    const compacted = mergedTurns.splice(0, mergedTurns.length - SESSION_COMPACT_TO);
    const compactText = compacted
      .map((turn) => `${turn.role}: ${String(turn.content || '').replace(/\s+/g, ' ').slice(0, 220)}`)
      .join(' | ');
    summary = `${summary}\n${compactText}`.slice(-12000);
  }

  sessionStore.set(sessionId, { turns: mergedTurns.slice(-SESSION_TURN_WINDOW), summary });
}

async function callModel(messages, { temperature = 0.4, model = MODEL } = {}) {
  if (!API_KEY) {
    throw new Error('Missing OPENAI_API_KEY. Set it before starting the server.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      messages,
    }),
    signal: controller.signal,
  });
  clearTimeout(timeout);

  const payload = await response.json();
  if (!response.ok) {
    const detail = payload?.error?.message || 'Model request failed';
    throw new Error(detail);
  }

  return {
    text: payload?.choices?.[0]?.message?.content || 'No response generated.',
    usage: payload?.usage || null,
    modelUsed: model,
  };
}

async function callWithRetry(messages, { temperature, preferredModel }) {
  try {
    return await callModel(messages, { temperature, model: preferredModel });
  } catch (firstError) {
    if (!FALLBACK_MODEL || FALLBACK_MODEL === preferredModel) throw firstError;
    return callModel(messages, { temperature, model: FALLBACK_MODEL });
  }
}

async function polishResponse(messages, draft, preferredModel) {
  const polishingPrompt = [
    ...messages,
    { role: 'assistant', content: draft },
    {
      role: 'system',
      content:
        'Polish the answer for clarity and structure. Preserve correctness and keep it concise. Do not add fluff.',
    },
  ];
  const polished = await callWithRetry(polishingPrompt, { temperature: 0.15, preferredModel });
  return {
    text: polished.text || draft,
    usage: polished.usage,
    modelUsed: polished.modelUsed,
  };
}

async function runUltraThink(messages, thinkLevel = 2, preferredModel = MODEL) {
  const effectivePasses = Math.max(1, Math.min(12, ULTRATHINK_PASSES * thinkLevel));
  let aggregatedUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let draft = '';
  let modelUsed = preferredModel;

  for (let pass = 1; pass <= effectivePasses; pass += 1) {
    const passMessages = [
      ...messages,
      ...(draft
        ? [
            {
              role: 'assistant',
              content: draft,
            },
          ]
        : []),
      {
        role: 'system',
        content:
          `UltraThink pass ${pass}/${effectivePasses}: improve accuracy, fill gaps, verify assumptions, then return only the best final answer without revealing hidden reasoning.`,
      },
    ];

    const reply = await callWithRetry(passMessages, { temperature: 0.2, preferredModel });
    draft = reply.text;
    modelUsed = reply.modelUsed;

    if (reply.usage) {
      aggregatedUsage = {
        prompt_tokens: aggregatedUsage.prompt_tokens + (reply.usage.prompt_tokens || 0),
        completion_tokens: aggregatedUsage.completion_tokens + (reply.usage.completion_tokens || 0),
        total_tokens: aggregatedUsage.total_tokens + (reply.usage.total_tokens || 0),
      };
    }
  }

  return {
    text: draft || 'No response generated.',
    usage: aggregatedUsage.total_tokens ? aggregatedUsage : null,
    modelUsed,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    try {
      const body = await parseBody(req);
      const userMessage = String(body?.message || '').trim();
      const mode = String(body?.mode || 'default').trim().toLowerCase();
      const thinkLevel = Math.max(1, Math.min(5, Number(body?.thinkLevel || 2)));
      const profile = String(body?.profile || 'balanced').toLowerCase();
      const sessionId = String(body?.sessionId || '').trim().slice(0, 120);

      if (!userMessage) {
        return sendJson(res, 400, { error: 'message is required' });
      }

      const clientHistory = Array.isArray(body?.history) ? body.history : [];
      const sessionState = getSessionState(sessionId);
      const history = [...sessionState.turns, ...clientHistory].slice(-24);
      const messages = [
        {
          role: 'system',
          content:
            `You are Jaws, a highly capable AI assistant focused on correctness, clarity, practical execution, and concise final outputs. Aim for an overall response quality bar of ${QUALITY_TARGET}/100 by validating assumptions, exposing uncertainty, and providing actionable steps.`,
        },
        ...(sessionState.summary
          ? [
              {
                role: 'system',
                content: `Long-session memory summary: ${sessionState.summary}`,
              },
            ]
          : []),
        ...history.slice(-12),
        { role: 'user', content: userMessage },
      ];

      const preferredModel = profile === 'deep' ? FALLBACK_MODEL || MODEL : MODEL;
      const cacheKey = getCacheKey({
        model: preferredModel,
        mode,
        thinkLevel,
        profile,
        message: userMessage,
      });
      if (responseCache.has(cacheKey)) {
        const cached = responseCache.get(cacheKey);
        storeSessionTurns(sessionId, [
          { role: 'user', content: userMessage },
          { role: 'assistant', content: cached.text },
        ]);
        return sendJson(res, 200, { ...cached, cached: true, qualityTarget: QUALITY_TARGET });
      }

      const baseReply =
        mode === 'ultrathink'
          ? await runUltraThink(
              [
                ...messages,
                {
                  role: 'system',
                  content: `UltraThink intensity is ${thinkLevel}x. Increase depth proportional to this level while keeping final output concise.`,
                },
              ],
              thinkLevel,
              preferredModel,
            )
          : await callWithRetry(messages, {
              temperature: profile === 'fast' ? 0.25 : 0.35,
              preferredModel,
            });

      const polishedReply =
        profile === 'fast'
          ? baseReply
          : await polishResponse(messages, baseReply.text, baseReply.modelUsed || preferredModel);

      const combinedUsage =
        polishedReply === baseReply
          ? baseReply.usage || null
          : baseReply.usage || polishedReply.usage
        ? {
            prompt_tokens: (baseReply.usage?.prompt_tokens || 0) + (polishedReply.usage?.prompt_tokens || 0),
            completion_tokens:
              (baseReply.usage?.completion_tokens || 0) + (polishedReply.usage?.completion_tokens || 0),
            total_tokens: (baseReply.usage?.total_tokens || 0) + (polishedReply.usage?.total_tokens || 0),
          }
          : null;

      const finalReply = {
        text: polishedReply.text,
        usage: combinedUsage,
        modelUsed: polishedReply.modelUsed || baseReply.modelUsed || preferredModel,
      };
      responseCache.set(cacheKey, finalReply);
      if (responseCache.size > 200) {
        const oldest = responseCache.keys().next().value;
        responseCache.delete(oldest);
      }

      storeSessionTurns(sessionId, [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: finalReply.text },
      ]);

      return sendJson(res, 200, { ...finalReply, cached: false, qualityTarget: QUALITY_TARGET });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unexpected server error';
      return sendJson(res, 500, { error: message });
    }
  }

  if (req.method === 'GET') {
    return serveStatic(url.pathname, res);
  }

  sendJson(res, 405, { error: 'Method not allowed' });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Jaws AI server running on http://localhost:${PORT}`);
});
