---
name: "prompt-cache-review"
description: "Reviews LLM prompt/API usage for caching, cost, schema size, tool output bloat, and prompt safety. Trigger: `/prompt-cache-review`, \"проверь prompt cache\"."
trigger_patterns:
  - "/prompt-cache-review"
  - "prompt cache"
  - "проверь prompt cache"
---

# Prompt Cache Review

Use `prompt-cache-reviewer`.

Focus on static/dynamic prompt split, cacheability, cost caps, output limits, and injection boundaries.

