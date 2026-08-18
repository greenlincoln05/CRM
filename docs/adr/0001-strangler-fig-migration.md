# 0001 — Replace Evosus incrementally, not all at once

Status: accepted
Date: 2026-08-18

## Context

Lake Champlain Pools runs 600-900 retail transactions, 50-80 service calls, and
15-20 deliveries or builds in a busy week, on twenty years of data in an on-prem
Evosus install. One person is building the replacement.

A big-bang cutover means the business runs on unproven software from day one. If
the register is wrong on a Saturday in June, there is no fallback.

## Decision

Build alongside Evosus, and move one domain at a time.

Evosus stays the system of record for money and inventory while the new system
becomes the system of record for things Evosus never handled well: the unified
customer record, the timeline, property profiles, photos. Those are additive, so
a bug is an annoyance rather than a business outage.

Order of transfer: customer/timeline/photos, then service and dispatch, then
inventory, then POS and payments.

## Consequences

POS is built last, despite being the most visible piece. It is the highest-risk,
most regulated, and least differentiated component, and it benefits most from a
domain model that has already been proven in daily use.

Two systems run at once for roughly a year. The read-only mirror is what makes
that tolerable: staff use one search box, not two.

Anything touching money cuts over January-March, outside both pool season
(April-September) and stove season (September-December).

If the project stalls after Phase 1, the business still keeps a working customer
record, timeline, and property profile system. Nothing is wasted.
