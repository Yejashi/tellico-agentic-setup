# Using the Tellico Qwen API

You have been given a base URL and an API key. That is everything you need —
no SSH, no cluster account, no VPN, nothing to install.

The endpoint speaks the OpenAI API, so any OpenAI-compatible client works by
pointing it at the base URL.

```text
base URL   https://HOST/v1          (as given to you)
API key    sk-tellico-...           (yours; do not share it)
model      qwen3.8-27b-gsq-iq3s
```

## curl

```bash
curl "$TELLICO_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $TELLICO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3.8-27b-gsq-iq3s",
    "messages": [{"role": "user", "content": "Explain NVLink in two sentences."}]
  }'
```

Add `"stream": true` for token-by-token output.

## Python

```python
from openai import OpenAI

client = OpenAI(base_url="https://HOST/v1", api_key="sk-tellico-...")

response = client.chat.completions.create(
    model="qwen3.8-27b-gsq-iq3s",
    messages=[{"role": "user", "content": "Explain NVLink in two sentences."}],
)
print(response.choices[0].message.content)
```

## Anything else

Most tools want the same two values under names like "OpenAI-compatible
endpoint" or "custom base URL":

```bash
export OPENAI_BASE_URL="https://HOST/v1"
export OPENAI_API_KEY="sk-tellico-..."
```

## Using it with OpenCode

Your key also runs the full agentic setup this cluster was configured for: a
lead model that dispatches work to two node-pinned workers in parallel. It
needs no SSH and no cluster account either.

```bash
git clone https://github.com/Yejashi/tellico-agentic-setup.git
cd tellico-agentic-setup
./install.sh            # choose "1) API key", then paste your key
opencode-tellico 0
```

The URL is already in the repository, so your key is the only thing you need
to have at hand.

`./doctor.sh` checks the whole path if something looks wrong. Ask the operator
for a key allowing 2-3 concurrent requests before you use this: one OpenCode
session issues several at a time, and a single-slot key makes it wait on
itself.

## What the model is

Qwen3.8-27B (ISTA-DASLab's GSQ-RCO IQ3_S quantisation), self-hosted on two
nodes of the Tellico cluster. It is a reasoning model served by llama.cpp with
speculative decoding. The earlier ids `qwen3.6-35b-a3b` and `qwen3.8-27b`
still work and reach this model.

- **Context**: 131,072 tokens per request. `/v1/models` reports it.
- **Thinking**: on by default. The reasoning text arrives in a
  `reasoning_content` field alongside `content`. To turn it off, send
  `"chat_template_kwargs": {"enable_thinking": false}` — worth doing for
  short, mechanical requests, since thinking costs tokens and time.
- **Suggested sampling**: `temperature` 0.6, `top_p` 0.95.
- **Tool calling** works, including parallel tool calls.

## Capacity, and what errors mean

This is two nodes in a university lab, not a hosted API. The whole cluster
serves only a handful of concurrent requests, and by default your key may hold
one at a time — a second simultaneous request waits rather than failing.

| Status | Meaning | What to do |
|---|---|---|
| `401` | Key not recognised, or revoked | Ask the operator for a new one |
| `404` | Unknown model id | Use `qwen3.8-27b-gsq-iq3s` |
| `429` | No slot came free in time | Retry with backoff; honour `Retry-After` |
| `503` | No model server is up | The cluster allocation has ended; tell the operator |
| `502` | A node dropped mid-request | Retry once; it routes to the other node |

So: retry on `429` and `503` with backoff, and expect a cold request to spend
a moment queueing when others are working. Long generations are fine — the
endpoint holds a request open for up to an hour.

`GET /health` needs no key and reports whether the cluster is up:

```bash
curl https://HOST/health
```

```json
{"status": "ok", "inflight": 0, "max_inflight": 3,
 "nodes": {"node0": "up", "node1": "up"}}
```

## Keep your key to yourself

Your key identifies you: usage is logged per user, and it can be revoked on
its own without disturbing anyone else. If it leaks, say so and get a new one.
