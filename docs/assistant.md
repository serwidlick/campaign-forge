# The assistant

An optional AI helper that lives in a column on the right. It reads your campaign through the same files you edit, answers questions about it, brainstorms, and, if you let it, writes.

It is the only part of the app that talks to a server, and only the Anthropic API with your own key. Nothing is sent anywhere unless you ask it something.

## Setting it up

1. Press the **Assistant** tile (the sparkle) at the bottom of the sidebar to open the assistant, then the gear for its settings.
2. Paste an Anthropic API key. It is stored in your operating system's credential store, not in the campaign folder.
3. Choose a model and an effort level. The strongest model costs the most per answer; the lightest is fine for look-ups.

## Permissions

Four switches decide what the assistant may do. Off means the app refuses that kind of call.

| Switch | Lets it                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------- |
| Read   | Search and read elements, and the PDF of a Document a few pages at a time.                          |
| Write  | Create new elements.                                                                                |
| Put    | Change existing elements: rename, retag, append to or replace a body, set fields.                   |
| Delete | Delete elements (they go to Recently deleted for 30 days). Leave this off unless you have a reason. |

The app checks every call against the switches before running it, and the assistant is told which abilities it has. You can flip a switch mid-conversation: the next message tells the assistant what changed.

## What it is good at

- "Who was the harbourmaster's sister?" with a link to the element it found.
- "Give me three rumours for the Rusty Tankard that fit what is written about it."
- "Append a recap of tonight to session 12." (with Put on)
- "Make a faction for the salt smugglers and link it to the harbour." (with Write on)
- "What does the module say about the lighthouse keeper?" It reads the pages of the attached PDF.

To build a whole set of elements from a book at once, use [Importing a PDF](importing-a-pdf.md) instead of asking turn by turn.

It links elements it mentions, so you can click straight to them. When it changes an element that is open, the editor reloads to show the change.

## Cost

Each reply shows the tokens used and an estimate of what it cost at that model's published price, and the session total sits in the header. The index of your elements is sent with every turn and cached by the API, so a long conversation is cheaper than the first message suggests.

The index is taken when a conversation starts; elements added or removed afterwards are announced to the assistant with your next message rather than by rebuilding the index. This keeps the conversation valid for the API, which ties the model's reasoning to the exact prompt that produced it, and keeps the cache warm. Start a new conversation to get a fresh index.

## Saved conversations

Every conversation is saved as you go, in the campaign's `conversations/` folder, one file each. It is saved when you send a message and again when the reply finishes, so closing the app mid-reply keeps your question.

- **New conversation** (the speech bubble with a plus) starts an empty chat. The one you were in stays saved.
- **Saved conversations** (the clock) lists this campaign's conversations, newest first. Click one to pick it up where you left off.
- The bin icon on a row deletes that conversation's file. It asks for a second click first.

A reopened conversation carries on with the same instructions and index it started with, plus a note of anything you added or removed since. Your current model, effort and permission switches apply to new replies.

Conversations hold the campaign text the assistant read, so they are GM-only: the table never serves them to players. If you share the campaign folder with someone, the conversations go with it unless you leave the `conversations/` folder out.

## Player-facing text

The assistant knows the `## Players know` convention. Ask it to write player-facing text and it puts it under that heading.
