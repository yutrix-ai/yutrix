# Yutrix Editions

Public overview of **Community** vs commercial surfaces. This repository is the **Community** edition only.

| Edition | Deployment | License | Source |
| --- | --- | --- | --- |
| **Community** | Self-host | **MIT** | This repo — [yutrix-ai/yutrix](https://github.com/yutrix-ai/yutrix) |
| **EE** (Standard / Enterprise) | Self-host / private cloud | Commercial (proprietary) | Private product line — not in this open-source tree |
| **SaaS** (Team / Business) | Hosted by Yutrix | Subscription | Hosted multi-tenant service — not in this open-source tree |

## Community (this repository)

- **Complete open-source LLM protocol gateway** and admin console for single-deployment self-hosting.
- **No commercial license file is required.** Full Community features run under MIT.
- Protocol routing, API keys, audit, concurrency, failover, strategy routing, and related ops features ship here as documented in the main README.

## What is *not* in this open-source tree

Commercial capabilities (for example multi-tenant SaaS control plane, enterprise SSO product packaging, commercial license gates, hard budget/quota billing product, and paid support SLAs) are **not** developed or published in this Community repository.

Product and commercial information: **[yutrix.cn](https://yutrix.cn)**.

## Compatibility note

Formerly **PromptGate**. Runtime environment variables such as `PROMPTGATE_*` remain supported during the published compatibility window so existing deployments can migrate without a hard break.
