# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios

## Users

People with a Bob account who use their iPhone to talk to Bob, plan their day and share with family or friends. Inferred from the app and repository; the owner confirmed the scope of the redesign, not this wording.

## Product Purpose

Bob lightens up people's moods. The native app makes talking to Bob and finding a conversation the most obvious things to do, and offers the same features as the web app.

## Positioning

A warm character people talk to by voice or text, across their phone, the web and physical Bob devices, with their private and shared spaces kept clearly apart.

## Operating Context

Short, frequent moments on a phone, often one-handed, sometimes by voice while doing something else.

## Capabilities and Constraints

- Five stable tabs in this order: Chats, Today, Bob, Spaces, You (owner approved, 2026-11-01; `docs/plans/ios-navigation-standard.md`).
- Light, dark and system appearance; saved appearance choices are preserved.
- Voice controls and captions. Only captions the app really produces may be shown; partial live transcripts are not a current capability.
- Apple Health is read-only, and sharing is explicit and reviewed.
- Remote push and Universal Links need paid Apple capabilities that are not in place.
- Conversation summaries from the server carry no last-message preview today.

## Brand Commitments

- The name Bob and the original Bob artwork.
- WhatsApp is the interaction reference, not a look to import. heybob.xyz is the brand source.
- harvee.app is the owner's example of the quality bar: one plain answer first, real content instead of menus, one type family, colour only where it means something. It is a reference, not a look or assets to copy.
- The owner chose on 2026-11-01 to keep the approved structure and Bob's look and rebuild the screens.

## Evidence on Hand

- Bob artwork: `apps/ios/Bob/Bob/Assets.xcassets`.
- Sample chats in Debug builds are fictional and are never evidence of the real app.

## Product Principles

The owner's philosophy: minimal, simple, consistent, functional. When a choice is close, remove something, reuse the shared part, and make sure it works before making it pretty.

1. Conversation comes first.
2. Show useful content before links to other screens.
3. Familiar iOS controls behave exactly as expected.
4. Quiet surfaces, with Bob adding warmth at useful moments.
5. Name every state. Never imply a capability the app does not have.

## Accessibility & Inclusion

Dynamic Type up to the largest accessibility sizes, VoiceOver for every action, 44 pt targets, measured contrast in both appearances, and Reduce Motion alternatives.
