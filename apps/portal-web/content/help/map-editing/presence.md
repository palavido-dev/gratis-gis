---
id: map-editing-presence
title: Live presence
summary: See who else is looking at the same map right now and where their cursor is.
category: map-editing
order: 42
complexity: basic
tags:
  - presence
  - cursors
  - collaboration
related:
  - map-editing-markup
  - map-editing-comments
---

Live presence shows you who else has the same map open right now.
Each viewer gets an avatar chip at the top of the canvas, and
their cursor position appears on the map as a colored arrow with
their name.

This is the simplest signal that you're not working alone. When
you're walking a teammate through a map over a video call, you
can move your cursor over the spot you're talking about and they
see it land in real time without you having to describe
coordinates.

## What you see

- **Avatar chips** in the top-right of the canvas, one per
  active viewer. Your own chip is included so you can confirm
  the connection works.
- **Cursor markers** for everyone else: a colored arrow with a
  small name label, drawn at their mouse position on the map.
  Your own cursor isn't drawn (no point self-watching).
- **Distinct colors** per viewer, drawn from a palette of eight
  high-contrast options. Two adjacent viewers always get
  different colors.

## How it works

The map editor prefers a live WebSocket so cursors update quickly.
If the socket cannot open (proxy, firewall, brief outage), it
falls back to the original HTTP heartbeat poll. Avatar chips and
cursor markers look the same either way; only the smoothness of
motion changes.

When you stop moving the cursor, your "last known position" stays
where you left it for a few seconds, then your chip drops off
until you wiggle the mouse again.

Cursors that have been idle for more than 5 seconds disappear so
the canvas doesn't get cluttered with stale arrows.

When you close the tab or navigate away, your chip drops off
immediately for everyone else.

## Privacy notes

- Only viewers who can already read the map ever see anyone
  else's presence. A private map's avatar list is gated by the
  same permission check as the map itself; nothing leaks.
- Presence is signed-in only. Anonymous public-link visitors do
  not appear in the avatar strip.

## Related

- [Markup](map-editing-markup) for leaving persistent pins on
  the map.
- [Comments](map-editing-comments) for threaded conversations.
