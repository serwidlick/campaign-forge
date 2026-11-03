# The assistant

An optional AI helper that lives in a column on the right. It reads your campaign through the same files you edit, answers questions about it, brainstorms, and, if you let it, writes.

It is the only part of the app that talks to a server, and only the Anthropic API with your own key. Nothing is sent anywhere unless you ask it something.

## Setting it up

1. Press the **sparkle** button at the top of the sidebar to open the assistant, then the gear for its settings.
2. Paste an Anthropic API key. It is stored in your operating system's credential store, not in the campaign folder.
3. Choose a model and an effort level. The strongest model costs the most per answer; the lightest is fine for look-ups.

## Permissions

Four switches decide what the assistant may do. Off means the tool does not exist for it that turn.

| Switch | Lets it                                                                           |
| ------ | --------------------------------------------------------------------------------- |
| Read   | Search and read elements. Needed for anything useful.                             |
| Write  | Create new elements.                                                              |
| Put    | Change existing elements: rename, retag, append to or replace a body, set fields. |
| Delete | Delete elements. Leave this off unless you have a reason.                         |

The permissions are enforced twice: the tools are not offered to the model, and the app refuses the call if it tries anyway.

## What it is good at

- "Who was the harbourmaster's sister?" with a link to the element it found.
- "Give me three rumours for the Rusty Tankard that fit what is written about it."
- "Append a recap of tonight to session 12." (with Put on)
- "Make a faction for the salt smugglers and link it to the harbour." (with Write on)

It links elements it mentions, so you can click straight to them. When it changes an element that is open, the editor reloads to show the change.

## Cost

Each reply shows the tokens used and an estimate of what it cost at that model's published price, and the session total sits in the header. The index of your elements is sent with every turn and cached by the API, so a long conversation is cheaper than the first message suggests.

## Player-facing text

The assistant knows the `## Players know` convention. Ask it to write player-facing text and it puts it under that heading.
