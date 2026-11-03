# Troubleshooting

## Windows says the publisher is unknown

SmartScreen warns about any installer that is not code-signed. Choose **More info**, then **Run anyway**. The installer is the one from the download page or the GitHub releases page; nothing else should be run.

## macOS says the app is damaged

Gatekeeper refuses downloaded apps that are not notarised, and on recent macOS versions it says "damaged" rather than "unidentified developer". Clear the quarantine flag once and the app opens:

```bash
xattr -cr "/Applications/Campaign Forge.app"
```

If Terminal says the path does not exist, the app is still inside the disk image or in your personal Applications folder. Drag it to Applications first, or type the command, then drag the app icon from Finder into the Terminal window to paste its real path.

Notarised builds, when the Apple signing secrets are set up, do not need this.

## Players cannot see my table

- Both machines must be on the same network. A phone hotspot counts as a network; a venue's guest Wi-Fi usually isolates devices from each other, and then discovery cannot work.
- On the GM's Windows machine, the firewall prompt must have been accepted. If it was declined, open Windows Security, Firewall, Allow an app through firewall, and tick Campaign Forge for private networks.
- On a Mac, the app needs local-network access. If it was declined, System Settings, Privacy & Security, Local Network.
- Discovery is a best effort. The typed address always works when the network allows the connection at all: the hosting panel shows the addresses, players press **Enter an address instead**.

## A player is stuck on "trying to reconnect"

The GM's machine stopped answering without ending the table: it went to sleep, changed network, or the app crashed. The player's app keeps trying. Either wait for the GM, or press **Leave table** and join again once the GM is back.

## The update banner never appears

The dev build never checks. On a release build, the banner needs a newer version on GitHub Releases, which also needs the installed version to be 0.1.1 or later. Press **Check for updates** on the welcome screen to see the result of a check, including any error.

## An element lost a link

Links point at ids, so a rename never breaks them. A link does break if the target file was deleted, or if its frontmatter `id` was edited by hand. The link text stays in the body; make the link again with @.

## The folder is in a cloud drive and I see a "conflicted copy" file

Two machines edited the same file before the sync finished. The app ignores the copy. Open both files in a text editor, merge by hand, and delete the copy.

## Something else

The app writes nothing outside the campaign folder except its own settings: recent campaigns, the assistant's settings, and the API key in your operating system's credential store. Removing and reinstalling the app never touches a campaign.
