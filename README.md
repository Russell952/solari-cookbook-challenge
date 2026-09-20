# Probe

**Evidence-driven software investigation system.**

Probe gives an AI the ability to investigate software from **code to real-world behavior**, run controlled experiments against a live application, and produce **evidence-backed conclusions**.

Instead of asking an AI to inspect code and guess whether something is broken, Probe lets it investigate the application through a controlled workflow:

    RECON → PLAN → EXECUTE → OBSERVE → ANALYZE
                             ↓
                      HYPOTHESIS
                             ↓
                      VERIFICATION
                             ↓
                  FINDING / INCONCLUSIVE
                             ↓
                          REPORT

> **AI proposes. Probe enforces. Evidence decides.**

---

## What Probe Investigates

An investigation starts with three inputs:

- **Repository** — what the application claims and how it is implemented
- **Live URL** — what the application actually does
- **Objective** — what the user wants investigated

Probe compares three sources of truth:

    Claimed reality   → README, docs, specifications
    Internal reality  → source code, dependencies, tests, config
    Observed reality  → real browser interaction

The goal is not to generate plausible bug reports. A potential issue must be supported by evidence and, for serious findings, independent verification.

---

## Architecture

    ┌─────────────────────┐
    │   React + Vite      │
    │      Client         │
    └──────────┬──────────┘
               │ HTTP / SSE
               ▼
    ┌─────────────────────┐
    │ Express + TypeScript│
    │    Orchestrator     │
    └─────┬──────┬────────┘
          │      │
          ▼      ▼
         AI    Solari
               Browser
               Sandbox
          │      │
          └──┬───┘
             ▼
        Evidence
             │
        ┌────┴────┐
        ▼         ▼
     MongoDB     B2
    (structured) (artifacts)

### Repository

    probe/
    ├── client/      # React + Vite frontend
    ├── server/      # Express + TypeScript backend
    ├── shared/      # Shared types and contracts
    └── examples/    # Solari/reference examples

---

## Investigation Flow

### 1. Recon

Probe establishes structured context about the target, including relevant links, forms, buttons, inputs, navigation controls, and other interactable elements.

### 2. Plan

The AI proposes experiments based on the investigation context.

### 3. Validate

AI-generated actions are validated before execution. The AI cannot bypass Probe's state machine, security rules, budgets, or action allowlist.

### 4. Execute

Solari provides real browser and sandbox execution.

### 5. Observe

Probe records application behavior and captures evidence.

### 6. Analyze

The AI interprets the collected observations and may form a hypothesis.

### 7. Verify

Potential findings are tested through targeted experiments rather than being accepted solely from the AI's reasoning.

### 8. Report

The investigation produces a report containing the evidence, hypotheses, findings, and limitations.

---

## Evidence

Evidence is a first-class part of Probe.

Depending on the experiment, evidence can include:

- Screenshots
- DOM/state observations
- Browser action results
- URLs
- Replay data
- Repository observations
- Experiment results

Structured investigation data is persisted in **MongoDB**, while binary evidence artifacts are stored in **Backblaze B2**.

Missing artifacts are handled explicitly rather than being presented as successful downloads or viewers.

---

## AI Boundaries

The AI handles reasoning; deterministic Probe code handles control.

The AI can:

- Propose experiments
- Interpret observations
- Generate hypotheses
- Suggest verification steps
- Help produce reports

The AI cannot independently:

- Change investigation state
- Bypass budgets
- Execute arbitrary tools
- Navigate outside the approved target scope
- Run arbitrary host commands
- Confirm its own findings
- Override security policies

This separation is central to the design.

---

## Security

Probe accepts arbitrary repository and application targets, so security is part of the core architecture.

Key protections include:

- Authentication and owner-scoped authorization
- Password hashing with Node's `scrypt`
- Signed HttpOnly sessions
- SSRF protection
- Connection-time network validation
- Navigation scope enforcement
- Restricted sandbox commands
- AI output validation
- Request body limits
- Rate limiting
- Investigation quotas
- Per-user and global concurrency limits
- CORS and security headers

Probe also distinguishes application failures from its own failures. A selector problem, AI provider error, Solari timeout, or infrastructure failure should not automatically become a bug in the investigated application.

---

## Resource Controls

Investigations are deliberately bounded to prevent runaway usage.

Current limits include:

| Resource | Limit |
|---|---:|
| Objective length | 1,000 characters |
| Evidence | 50 / investigation |
| Investigations | 5 / user / hour |
| Concurrent investigations | 2 / user |
| Global concurrency | 5 |
| Browser actions | 40 / investigation |
| AI calls | 20 / investigation |
| Runtime | 10 minutes |

These limits provide both cost control and protection against excessive resource usage.

---

## Reliability

Probe handles failures from external systems rather than assuming they always succeed.

It includes bounded handling for:

- AI timeouts and provider failures
- Malformed AI responses
- Browser failures and retries
- Navigation failures
- Replay availability failures
- Sandbox failures
- Database/storage failures
- SSE disconnections
- Orphaned investigations
- Runtime watchdog expiry

The frontend combines SSE with periodic polling so temporary connection failures do not leave an investigation permanently stuck.

---

## Testing

The project includes automated tests covering:

- Investigation lifecycle
- Orchestration
- AI validation
- Browser execution
- Authentication and authorization
- SSRF and navigation security
- Evidence persistence
- Artifact handling
- Resource budgets
- Rate limiting
- Recovery
- Frontend progress behavior
- Shared contracts

The system has also been tested through real Solari investigations and production smoke tests.

---

## Production

Probe is deployed as two services.

**Frontend**

`https://probe-challenge.vercel.app/`

Vercel

**Backend**

`https://api-probe.onrender.com/`

Render

MongoDB provides durable structured persistence and Backblaze B2 stores binary evidence artifacts.

Production secrets and environment configuration are kept outside the repository.

---

## Local Development

### Requirements

- Node.js
- npm
- MongoDB
- Solari configuration for real investigations
- AI provider configuration

Install dependencies:

    npm install

Run the development applications using the repository's configured scripts.

Environment-specific configuration should be supplied locally and should not be committed to Git.

---

## Current Status

Probe is a working research/engineering project demonstrating:

- AI-assisted investigation planning
- Real browser interaction
- Controlled experiments
- Evidence capture and persistence
- Hypothesis generation
- Independent verification
- Finding confirmation
- Security and resource controls
- Production deployment

Known future hardening areas include more precise AI token accounting, artifact-size enforcement, shared quota state for horizontal scaling, stronger test isolation, and broader end-to-end coverage.

---

## Core Idea

Traditional AI bug hunting can look like:

    Code → AI analysis → guessed bug → report

Probe is designed around:

    Code
      +
    Live application
      +
    Real interaction
      +
    Controlled experiments
      +
    Evidence
      +
    Verification
      =
    Evidence-backed investigation

**Probe doesn't just ask an AI what might be wrong. It gives the AI a controlled environment to find out.**
