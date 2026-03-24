const modal = document.getElementById('jawsModal');
const dialog = modal.querySelector('.dialog');
const openButton = document.getElementById('openModal');
const closeElements = modal.querySelectorAll('[data-close="true"]');
const chatWindow = document.getElementById('chatWindow');
const form = document.getElementById('chatForm');
const promptInput = document.getElementById('prompt');
const ultraThinkInput = document.getElementById('ultraThink');
const thinkLevelInput = document.getElementById('thinkLevel');
const profileInput = document.getElementById('profile');
const sendBtn = document.getElementById('sendBtn');
const statusNode = document.getElementById('status');

let lastFocused = null;
const history = [];
const SESSION_KEY = 'jaws_session_id';
const sessionId = localStorage.getItem(SESSION_KEY) || `jaws-${crypto.randomUUID()}`;
localStorage.setItem(SESSION_KEY, sessionId);

function setStatus(text) {
  statusNode.textContent = text;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function appendMessage(role, text) {
  const node = document.createElement('article');
  node.className = `msg ${role}`;
  const p = document.createElement('p');
  p.textContent = text;
  node.append(p);
  chatWindow.append(node);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function setModalOpen(open) {
  modal.classList.toggle('open', open);
  modal.setAttribute('aria-hidden', String(!open));
  document.body.style.overflow = open ? 'hidden' : '';

  if (open) {
    lastFocused = document.activeElement;
    requestAnimationFrame(() => dialog.focus());
  } else if (lastFocused && typeof lastFocused.focus === 'function') {
    requestAnimationFrame(() => lastFocused.focus());
  }
}

async function sendToModel(message) {
  const mode = ultraThinkInput.checked ? 'ultrathink' : 'default';
  const thinkLevel = Number(thinkLevelInput.value || 2);
  const profile = profileInput.value || 'balanced';
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, history, mode, thinkLevel, profile, sessionId }),
  });

  const raw = await response.text();
  const payload = safeJsonParse(raw);
  if (!payload) {
    const snippet = raw.replace(/\s+/g, ' ').slice(0, 140);
    throw new Error(`Server returned non-JSON response (status ${response.status}): ${snippet}`);
  }
  if (!response.ok) {
    throw new Error(payload?.error || 'Request failed');
  }

  return payload;
}

openButton.addEventListener('click', () => setModalOpen(true));

for (const item of closeElements) {
  item.addEventListener('click', () => setModalOpen(false));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal.classList.contains('open')) {
    setModalOpen(false);
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const prompt = promptInput.value.trim();
  if (!prompt) return;

  sendBtn.disabled = true;
  promptInput.disabled = true;
  const modeLabel = ultraThinkInput.checked ? 'UltraThink' : 'Standard';
  setStatus(`Thinking (${modeLabel})...`);

  appendMessage('user', prompt);
  history.push({ role: 'user', content: prompt });
  promptInput.value = '';

  try {
    const payload = await sendToModel(prompt);
    const answer = String(payload?.text || '').trim() || 'No response generated.';
    appendMessage('assistant', answer);
    history.push({ role: 'assistant', content: answer });

    if (payload?.usage) {
      const usage = payload.usage;
      setStatus(`${modeLabel} done · profile:${profileInput.value} · model:${payload?.modelUsed ?? 'default'} · target:${payload?.qualityTarget ?? 94}/100 · tokens prompt:${usage.prompt_tokens ?? '?'} completion:${usage.completion_tokens ?? '?'} total:${usage.total_tokens ?? '?'}${payload?.cached ? ' · cache-hit' : ''}`);
    } else {
      setStatus(`${modeLabel} done · profile:${profileInput.value} · model:${payload?.modelUsed ?? 'default'} · target:${payload?.qualityTarget ?? 94}/100${payload?.cached ? ' · cache-hit' : ''}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error';
    appendMessage('assistant', `Error: ${message}`);
    setStatus('Error');
  } finally {
    sendBtn.disabled = false;
    promptInput.disabled = false;
    promptInput.focus();
  }
});
