# Ghost → Discord Worker — Specification

This directory contains the complete specification for the **Ghost → Discord Cloudflare Worker**, a serverless integration that synchronizes Ghost CMS membership events to Discord roles in real time.

## Document Index

| # | Document | Description |
|---|----------|-------------|
| 01 | [Overview](./01-overview.md) | Purpose, scope, goals, non-goals, glossary |
| 02 | [Architecture](./02-architecture.md) | System components, data flow, deployment topology |
| 03 | [Data Model](./03-data-model.md) | KV schema, payload shapes, TypeScript types |
| 04 | [API Reference](./04-api-reference.md) | HTTP endpoints, request/response contracts |
| 05 | [Authentication](./05-authentication.md) | Signature schemes, secrets, token formats |
| 06 | [Event Handling](./06-event-handling.md) | Ghost webhook → Discord role transitions |
| 07 | [Slash Commands](./07-slash-commands.md) | `/link` and `/unlink` interaction flows |
| 08 | [Configuration](./08-configuration.md) | Environment variables, KV setup, Ghost & Discord setup |
| 09 | [Security](./09-security.md) | Threat model, mitigations, secrets handling |
| 10 | [Error Handling](./10-error-handling.md) | Failure modes, status codes, observability |

## Version

Specification version: **1.0.0** — corresponds to worker `package.json` version `1.0.0`.

## Audience

- Maintainers implementing or modifying the worker
- Operators deploying and configuring the integration
- Reviewers auditing security and authentication flows
