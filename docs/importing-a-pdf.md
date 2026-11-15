# Importing a PDF

Start a campaign from a book instead of a blank page. Give the app an adventure module, a setting guide, a bestiary or your own notes as a PDF, and it builds the characters, factions, creatures, locations, items, quests, events and lore the text describes, as ordinary elements you can read, edit and share like any other.

It uses the [assistant](assistant.md): the model reads the book's text with your own API key. Without a key the import cannot run.

## Steps

1. Press the **import** button (the arrow-out-of-a-page icon) next to **New** above the element list.
2. **Choose a file**: a PDF, or a plain-text file (`.txt`, `.md`). The app pulls the text out and shows how many pages and how much text it found. A text file is cut into parts of a few thousand characters, or at its form-feed page marks when it has them, and those parts stand in for pages everywhere below.
3. Say what to look for:
   - **What to look for**: the kinds of element to build. Arcs, sessions, journal entries and maps are never proposed; those are yours.
   - **About this book**: a line of context, such as what the adventure is or which chapter matters. It goes to the model with every part.
   - **Pages**: narrow to a chapter to save money or skip the appendices.
   - **Keep the file**: copy a PDF into the campaign as a Document element so every element made from it can cite it by page. On by default. A text file is only read; elements cite it by name and part.
   - The line at the bottom says how many model calls the run will take and roughly what it will cost at list price.
4. **Read the book.** The text goes to the model in parts of about forty-eight thousand characters. A progress bar shows the part being read, how many elements have been found and the tokens spent so far. You can stop at any time and review what was found.
5. **Review.** Everything found is listed by kind with a one-line summary and the pages it came from; open a row to read the body the model wrote. Untick what you do not want. Something that already exists in the campaign under the same name is marked **already here** and is unticked; tick it and the import appends a section to your element instead of creating a twin.
6. **Create.** The ticked elements are written as Markdown files. Nothing touches the campaign folder before this step.

## What you get

- Each new element starts from its kind's template (a 5e creature gets a stat block when the book gives one) with the model's notes as the body, a `## Players know` heading at the end, and the tag `imported`.
- Each body ends with a **Source** line: the Document element and the pages the thing was described on. Click it to open the PDF beside the element.
- Mentions of other imported elements in a body become links by id, so the graph fills in and renames never break them.
- The Document element itself carries the PDF and lists when it was imported.

The bodies are the model's paraphrase of the text, not the text. Read them with the book open and fix what it got wrong; they are a first draft of your notes, made in minutes instead of an evening.

## Scanned books

Only real text can be read. A scanned PDF holds pictures of pages, and the import will tell you that hardly any text came out. Run it through an OCR tool first (most PDF readers have one) and import the result.

Books from the Internet Archive come with the OCR already done: their PDF carries a hidden text layer the import can read, and the **FULL TEXT** download is the same text as a plain file, without page headers and footers muddled into it. Either works; the text file is the cleaner read, and the PDF is the one to import if you want the book kept in the campaign.

## Cost

A two-hundred-page module is a few dollars with the default model and much less with Haiku. The estimate before you start assumes dense prose; art-heavy books cost less. Every model call is counted in the progress line, and the assistant's own settings choose the model and effort.

## Reading PDFs in the assistant

Whether or not you imported a book, the assistant can read any Document element's PDF a few pages at a time when **Read** is on. Ask "what does the module say about the lighthouse on page 40?" and it looks. Imported elements point it at the right pages through their Source line.
