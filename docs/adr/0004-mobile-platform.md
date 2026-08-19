# 0004 — Technician app is a PWA, and what that costs

Status: accepted, with a known unmet requirement
Date: 2026-08-18

## Context

Technicians run 50–80 service calls a week across Vermont and northern New York.
Many properties are on the lake with no usable signal. The technicians use their
own personal phones.

Two requirements were stated: a mobile technician app, and real-time technician
GPS on a dispatch board.

## Decision

Build the technician app as an installable web app (PWA), served from the same
Next.js application as the back office at `/tech`.

- No app store, no TestFlight expiry, no Apple developer account.
- Updates ship the moment they are deployed, which matters when the person
  fixing a bug is also the person running the store.
- One codebase, one deployment, one set of queries.
- It can be built and verified on the machine it is developed on, which the
  native path could not be.

## The unmet requirement

**A PWA cannot report location in the background.** Not "with difficulty" —
iOS and Android both suspend web execution when the screen is off or the browser
is backgrounded. Continuous tracking of a technician driving between jobs is not
achievable this way, and no amount of engineering changes that.

What is implemented instead:

- A position fix at every meaningful moment — en route, arrival, each photo,
  completion — stored in `work_order_ping`.
- Continuous position while the app is open on a job.

That answers what dispatch actually asks — did the technician get there, when,
and how long did it take — but it is not a live map of moving trucks.

Three ways to close the gap, in increasing cost:

1. **Keep vehicle tracking in the existing fleet system.** It already exists and
   already does this. Recommended.
2. **Wrap this same codebase in Capacitor.** A native shell around the web app,
   with a background geolocation plugin. Costs an Apple developer account and a
   release process, but is not a rewrite — the app itself is unchanged.
3. **Rebuild native in Expo.** Only if something beyond location makes it
   necessary.

Choosing the PWA now does not close any of these doors. Choosing native now
would have closed the PWA one.

## Personal phones

Technicians use their own devices, which changes what may be cached.

- Gate codes are cached **only for properties on today's route**, and expire at
  end of day. On a personal phone that is the difference between holding four
  codes until tonight and holding every code the company has.
- Job data, access notes, and photos are cached for offline use. Photos are
  deleted from the device once the upload confirms.
- `wipeDevice()` clears everything, for sign-out or a phone changing hands.
- There is no MDM and there will not be one. The mitigation is holding less,
  not controlling the device.

## Offline

The app reads from IndexedDB first and treats the network as a background
refresh. Opening it in a dead zone shows the same thing it showed in the yard.

Every action is written locally, applied to the UI immediately, and queued with
a client-generated id. The server records which ids it has applied, so a replay
— which will happen, because networks fail after the server commits and before
the response arrives — lands once.

Local edits that have not synced are marked dirty and survive a refresh from the
server. A technician who writes notes in a dead zone must not lose them the
moment signal returns; that would be the fastest possible way to lose their
trust in the system.

## Consequences

- Dispatch gets breadcrumbs, not a live map, until item 1 or 2 above.
- iOS may evict IndexedDB for web apps unused for an extended period. For an app
  opened every working day this is unlikely, and the server remains the record
  of truth — eviction costs a re-sync, not data.
- Photo capture goes through the system camera picker rather than a custom
  in-app camera. Fewer frames per second, one less thing to build.
