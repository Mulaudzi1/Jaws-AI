# Jaws AI (Functional Modal App)

Jaws is now a complete end-to-end AI chat modal application:

- Front-end modal chat UI (`index.html`, `styles.css`, `app.js`)
- Back-end HTTP server (`server.js`)
- Real model inference via OpenAI-compatible Chat Completions API (`/api/chat`)
- Optional **UltraThink** multi-pass mode for deeper answer refinement
- UltraThink intensity control (1x–5x) for stronger depth on hard prompts
- Performance profiles (`fast`, `balanced`, `deep`) to trade latency vs depth
- Session-aware server memory and short response cache for reliability/speed

## Run

```bash
export OPENAI_API_KEY="your_api_key"
# optional
# export OPENAI_MODEL="gpt-4.1-mini"
# export OPENAI_FALLBACK_MODEL="gpt-4.1-mini"
# export OPENAI_BASE_URL="https://api.openai.com/v1"
# export ULTRATHINK_PASSES="2"
# export JAWS_QUALITY_TARGET="94"
# export JAWS_REQUEST_TIMEOUT_MS="30000"
# export JAWS_SESSION_TURN_WINDOW="40"
# export JAWS_SESSION_COMPACT_TO="20"

npm start
```

Then open:

- `http://localhost:3000`

## Notes

- The app sends user prompts to `/api/chat`.
- The server forwards requests to the configured model provider.
- UltraThink mode performs multiple refinement passes server-side before returning the final answer.
- UltraThink intensity influences depth guidance sent to the model.
- `fast` profile minimizes extra passes; `balanced`/`deep` use a polish pass for better clarity.
- Server uses rolling per-session memory compaction so conversations keep going without hard prompt exhaustion in normal usage.
- Server keeps limited response caching to improve repeated-query speed consistency.
- Jaws defaults to a 94/100 quality target (`JAWS_QUALITY_TARGET`) and returns this target in API responses.
- No proprietary UI/assets were copied; this is an original implementation.
