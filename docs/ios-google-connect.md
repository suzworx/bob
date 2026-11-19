# Native Google connection

The native app uses ASWebAuthenticationSession for Google consent and returns directly to Bob. It does not require a second Bob sign-in in Safari. The six capability choices mirror the web app; sending and modifying mail require explicit choices. Google tokens remain on the server.

## Deployment

1. Deploy the bridge ([google-connect.md](google-connect.md)) with its optional `GOOGLE_CONNECT_NATIVE_CALLBACK_URL` set to `https://<your-app-host>/api/google-accounts/native/return`. Keep all existing browser callback entries.
2. Apply the additive native-consent migration. The sidecar table preserves existing prepared web consent result shapes.
3. Set optional `BOB_GOOGLE_NATIVE_CALLBACK_URL` on the API server to the same fixed HTTPS URL. The four Google runtime settings stay unchanged. Leave the native value unset to keep native authorization unavailable without changing browser consent.
4. The public relay only redirects bounded state and a sanitized outcome; authenticated native endpoints complete or cancel using the original active session and the app-held verifier.
5. Build and install the native app. Its registered callback scheme is `app.bob.oauth`; it accepts callback state only inside the retained authentication session. No Associated Domains or Push entitlement is needed for this return transport.

The Google-to-Connect provider redirect URI is unchanged. This is a Connect-to-Bob return destination, not a new Google OAuth client. No provider client secret, Bob bearer, authorization code or app-held verifier belongs in the app callback URL.

## Recovery and privacy

An attempt expires after ten minutes. Completion claims it once with a bounded processing deadline; retrying completion retrieves a committed result or the current bounded state. Cancellation returns a completed result if linking already committed. Unknown/expired ownership or session proof ends the local attempt; uncertain network cancellation offers a truthful close and account refresh. A closed app loses the in-memory verifier and starts a fresh attempt next time.

The server serializes admission, final persistence and erasure per owner, checks the original active session, and fences sessions that predate account erasure. Account switching, sign-out, superseded reconnects and delayed callbacks cannot borrow a new account session.

## Acceptance

Source tests and builds cover proof validation, original-session isolation, callback spoofing, cancellation/expiry, lost-response recovery, concurrent completion, supersession and account erasure. A synthetic fixture can prove the actual authentication-session browser return without reading a real Google account. Actual Google consent still requires a separate live acceptance run: connect, select capabilities, return to Bob, cancel/retry, reject wrong-account reconnect, and verify two-account isolation. Do not equate demo screens, a bridge authorization URL, or a synthetic return with verified provider linking.
