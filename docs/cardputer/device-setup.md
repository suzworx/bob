# Setting up an Bob Cardputer (customer guide)

For someone who bought the device and sets it up alone: no computer, no cable,
no developer. The on-device screens are in #669 (spec comments 3 and 4 of 6);
this page is the quick-start card, the FAQ and the support checklist.

## Quick-start card (print-ready)

> **Bob: set up in about 2 minutes**
>
> 1. Switch Bob on. It says **HI, I'M BOB**. Press **Enter** (or **s** to set up later).
> 2. Pick your home Wi-Fi from the list and press **Enter**.
>    Bob uses **2.4 GHz** Wi-Fi. Not in the list? Pick **My network isn't listed**.
> 3. Type your Wi-Fi password and press **Enter**. **Tab** shows what you typed.
> 4. Bob shows **PAIR YOUR BOB** with a code. On your phone, open **app.heybob.xyz**
>    (or scan the QR code on the screen), sign in, enter the code, and approve.
> 5. **ALL SET!** Hold **GO** and ask a question.
>
> **Settings**: press **,** (comma) on the Ready, Wi-Fi, pairing or "Bob is away" screen.
> **Moved house or changed router?** Hold **Fn** and **Esc** ( ` ) while you switch Bob on.
> Never hold GO while switching on.

## Keys you need

| Key | Where | What it does |
| --- | --- | --- |
| `,` | Ready, any Wi-Fi screen, the pairing screen or "Bob is away" | Opens Settings |
| `;` `.` | Lists | Up / down |
| Enter | Lists, fields | Choose / confirm |
| `` ` `` (Esc) | Lists, screens | Back |
| Tab | Password | Show or hide what you typed |
| Del | Fields | Erase (hold to erase more) |
| Fn + `,` / Fn + `/` | Fields | Move the cursor left / right |
| Fn + `` ` `` | Fields | Cancel (in a field every other key types, `` ` `` included) |
| Fn + `` ` `` held at power-on | Switching on | Opens the Wi-Fi settings; nothing is erased |

## FAQ

**My Wi-Fi isn't in the list.** Bob's radio uses 2.4 GHz only. Many routers
broadcast 2.4 GHz and 5 GHz under one name; if yours has separate names, pick
the 2.4 GHz one, or turn 2.4 GHz on in the router's app. A hidden network:
choose **Type a network name**.

**It says COULDN'T JOIN.** Bob says why: "Check the password and try
again." (check capital letters and symbols; press Tab to see what you typed),
"Can't find it. Is it on and near?", or "It didn't answer in time." Nothing
is saved until Bob actually joins.

**It says NEEDS SIGN-IN (hotels, cafés, airports).** That Wi-Fi wants a
sign-in page, which Bob can't open. Use your phone's hotspot instead: add it
in Settings → Wi-Fi networks. Bob tries saved networks in order and falls
back to the next one by itself.

**It says NO WI-FI or NO INTERNET.** Bob keeps trying on its own (every
minute, then every 5 minutes) and never restarts. Press Enter to try now, or
`,` to check your networks.

**It says BOB IS AWAY.** Your Wi-Fi is fine; Bob's servers are not
answering. It keeps trying.

**How many networks can it remember?** Five, tried in the order shown in
Settings → Wi-Fi networks (Move up / Move down changes it). A sixth asks which
one to replace.

**A timer went off while I was in Settings.** A ringing timer closes Settings
and rings (anything you had not saved yet is dropped, as when you press Esc).
Other messages wait until you leave Settings.

**I'm giving Bob away.** Settings → Reset → **Factory reset**, type `RESET`.
Then remove it from your account at app.heybob.xyz → Devices.

## Reset options

| Option | Clears | Keeps |
| --- | --- | --- |
| Forget all Wi-Fi | every saved network and password | pairing, server, sound |
| Server back to Production (developer options only) | Local dev / Custom servers | every pairing |
| Unpair this device | this server's pairing | Wi-Fi, other pairings |
| Factory reset (type `RESET`) | everything | nothing: Bob starts as new |

## For support

Ask the customer to open **Settings → About** and read it out: firmware and
build, the device name, the server (Production unless someone enabled
developer options), the Wi-Fi network and its signal, and whether the
internet and Bob are reachable. About never shows a password, a token or a
server address.

The device journal (`docs/log-reference.md`) names Wi-Fi networks by slot
number only (`wifi_joined slot=1`) and servers by profile (`profile=prod`),
never by SSID, password, host or token.
