# Native iPhone push alerts: activation and acceptance

Remote alerts use APNs through the shared API's notification outbox. Local timer
notifications use iOS scheduling and work without APNs. Neither transport owns
agent logic. Related issues: #1207 and #1264.

## Current activation dependency

The 2026-11-01 signing probe rejected Push Notifications for the current Personal
Team; its provisioning profile also lacked `aps-environment`. A paid Apple
Developer Program team with Push Notifications enabled for the exact bundle ID
is required before this build can register with APNs. Installing a development
build directly on both phones does not remove that requirement. See Apple's
[supported capabilities](https://developer.apple.com/help/account/reference/supported-capabilities-ios).

The code and local tests are not evidence of delivery through Apple. Keep remote
alerts marked unverified until the physical-phone acceptance checks below pass.

## Activate the server

1. Enable Push Notifications for the app identifier and obtain an APNs signing
   key for that team. Follow Apple's [token-based APNs setup](https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns).
2. Configure these exact names in the API server's environment:

   | Name | Value expected by the server |
   | --- | --- |
   | `APNS_KEY_ID` | Apple key identifier |
   | `APNS_TEAM_ID` | Apple developer team identifier |
   | `APNS_PRIVATE_KEY` | Complete `.p8` PEM signing key, EC P-256 |
   | `APNS_TOPICS` | Comma-separated allowed bundle IDs; default `app.bob.ios` |

   Keep them in your deployment's secret store; never put key material in command
   arguments, source, logs, screenshots, or the native app. See
   [secrets.md](secrets.md).
3. Apply the push-notification migrations to your database before activating
   the API, then restart the API so its provider reads the new values at boot.

## Sign the matching native build

Use a provisioning profile for the same team and bundle ID as the APNs key/topic.
Pass these Xcode build-setting overrides together:

| Build | `BOB_PUSH_ENTITLEMENTS` | `BOB_PUSH_ENVIRONMENT` | `BOB_APNS_ENTITLEMENT` |
| --- | --- | --- | --- |
| Development profile | `Bob/BobPush.entitlements` | `sandbox` | `development` |
| Distribution / TestFlight | `Bob/BobPush.entitlements` | `production` | `production` |
| Personal Team / local alerts only | `Bob/Bob.entitlements` | `disabled` | `development` (unused) |

The checked-in defaults disable push. `CODE_SIGN_ENTITLEMENTS` reads
`BOB_PUSH_ENTITLEMENTS`; Info.plist `BobPushEnvironment` reads
`BOB_PUSH_ENVIRONMENT`. Inspect the **signed** app and profile entitlements, not
just project settings, to confirm the matching `aps-environment`. Install and
launch once on each phone, sign in, and allow notifications in Bob's notification
settings. Enable banners and sounds and disable Focus for the initial check.

## Registration contract and evidence

The native client sends authenticated `POST /api/push/devices` with
`installation_id` (UUID), `token` (64–512 hexadecimal characters, even length),
`environment` (`sandbox` or `production`), `topic`, `app_version`, and
`local_timer_ids` (at most 60 UUIDs). The authoritative boundary is
[push-schemas.ts](../apps/api/src/notifications/push-schemas.ts).

`{"registered":true,"delivery_available":true}` means registration succeeded and
the server could construct its configured provider. It does **not** verify Apple
accepted the key, the profile matches, or the phone displayed anything. `false`
means provider configuration is unavailable. `DELETE /api/push/devices/:installationId`
removes only the authenticated account's registration. Rebinding an installation
atomically removes its previous account binding, including after token rotation.

Timer coverage includes successfully scheduled pending local alerts and receipts
retained until the timer's deadline plus 15 minutes, for the current account only.
Do not substitute every server timer ID: that would suppress undelivered alerts.
Push lock-screen text stays generic; version-1 `bob` payload IDs are validated and
account-checked before the native app fetches or opens a target.

## Physical-phone acceptance

Record build/commit, signing environment, scenario, and pass/fail without tokens,
account identifiers, or personal notification contents.

1. Sign the same account into both phones. Close Bob, lock both phones, then create
   a timer from the web so neither phone has scheduled it locally. Both must show
   the remote alert; tapping must open the correct timer after a cold launch.
2. Create a timer in one phone, close Bob, and verify one alert on that phone and
   remote delivery on the other. Reopen after expiry and confirm no duplicate
   alert from a refreshed registration or delivery retry.
3. Use two accounts, one on each phone. Send a reminder to one selected recipient;
   only that recipient receives it. Verify a generic lock-screen preview and the
   correct authorized resource on tap. Repeat with an ordinary inbox update.
4. Switch the first phone to the second account, then send to each account. The
   phone must receive only the new account's alerts. Sign out and repeat: no new
   alerts may arrive for the signed-out session, and an old notification tap must
   not open another account's content.
5. Check muted notification preferences and quiet hours for ordinary updates;
   timers must still follow timer delivery policy. Repeat a cold-launch tap and
   verify disabled iOS permissions show an actionable status in Bob.

APNs acceptance, visible delivery, and tap routing are separate checks. The
`v2.push_delivery` event contains aggregate counts only; it cannot prove a banner
was displayed. Preserve the local-timer fallback if APNs activation is incomplete.
