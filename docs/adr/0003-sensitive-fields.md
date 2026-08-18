# 0003 — Sensitive field handling

Status: accepted, partially implemented
Date: 2026-08-18

## Context

The property profile deliberately stores gate codes, lockbox codes, alarm
information, and access instructions. That is the point of the feature: a
technician should know how to get in before arriving.

It also means the database holds the means of physical entry to several hundred
Vermont and New York homes.

## Decision

1. `property.gate_code` and similar fields are never displayed in list views,
   only on a property a technician has an assigned job for.
2. Access to these fields is logged.
3. Before the technician mobile app ships (Sprint 3), these columns get
   column-level encryption with the key held outside the database.
4. They are excluded from any export, report, or AI context window.
5. Photo storage keys are unguessable; images are served through signed,
   short-lived URLs, never public bucket paths.

## Status

Points 1-2 are policy, not yet enforced in code — there is no UI yet. Point 3 is
a hard gate on the Sprint 3 mobile app and is tracked as a blocking task.

## Consequences

A stolen database backup should not be a stolen set of house keys.

This also affects the AI features in Phase 4: property summaries must be
generated from a filtered view, never from `SELECT *`.
