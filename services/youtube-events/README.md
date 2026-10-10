# Optional YouTube events receiver

Polling works without this service. It is a separate process with a separate database and bearer token. It accepts signed YouTube Atom notifications and lets the desktop worker retrieve durable event hints. It has no desktop OAuth credentials, media API, or publication capability.

Run only after choosing and authorizing a hosting setup. Provide HTTPS for the public callback through your hosting proxy; the Node listener binds loopback. Configure the selected channel IDs explicitly:

```sh
export YOUTUBE_EVENT_STORE=/absolute/private/directory/youtube-events.sqlite
export YOUTUBE_EVENT_TOKEN='a-separate-random-token-of-at-least-24-characters'
export YOUTUBE_CALLBACK_ORIGIN=https://receiver.example.com
export YOUTUBE_EVENT_CHANNELS=UC0000000000000000000001,UC0000000000000000000002
export YOUTUBE_EVENT_PORT=8787
node --experimental-sqlite --import tsx services/youtube-events/main.ts
```

The receiver registers only these channel topics with Google's hub, validates the callback capability/token and exact topic, confirms bounded challenges, persists the actual lease and renews before expiry. Failed renewals preserve the old lease and back off. Callback HMAC signatures are required because subscriptions request `hub.secret`. Do not log callback URLs: each contains a private capability token. Its SQLite file is permission-protected; create or use a private directory with mode 0700 too. A receiver database cannot be reused under a different callback origin.

Set these only in the desktop worker environment:

```sh
export CAPY_YOUTUBE_EVENTS_URL=https://receiver.example.com/events
export CAPY_YOUTUBE_EVENTS_TOKEN='the-same-independent-retrieval-token'
```

The existing worker maintenance tick retrieves up to 100 events per pass. Its durable cursor advances only after a fully validated page commits locally. Replacing the receiver database changes its identity and starts retrieval from zero. Events for unwatched/disabled/destination channels are ignored; video readiness, original reading principal and import cutoff are rechecked through ordinary reconciliation. Title/description edits cannot reclip an already claimed source. Receiver errors preserve normal polling and are stored in `discovery-receiver-health` for status inspection.

The public endpoints are `GET/POST /callback/:channelId?token=...` and bearer-authenticated `GET /events?after=<sequence>`. Notifications are limited to 64 KiB and 100 entries, parsed as Atom with the expected YouTube namespace, and reject DTD/entity declarations, parser errors, mismatched channels/topics, invalid signatures and expired subscriptions. Replay identities persist across restart. Retrieval contains event IDs/timestamps only, never subscription secrets.

The local integration test starts an actual loopback HTTP listener, verifies a challenge, replays a signed callback and retrieves it through the real authenticated worker client. It performs no real hub subscriptions or deployment:

```sh
NODE_OPTIONS=--experimental-sqlite pnpm exec vitest run test/youtube-events.test.ts
```

Primary protocol documents: [Google YouTube push guide](https://developers.google.com/youtube/v3/guides/push_notifications), [WebSub](https://www.w3.org/TR/websub/). The hub's live acceptance, public TLS/proxy configuration, quota and operational hosting remain to be tested in a separately authorized deployment.
