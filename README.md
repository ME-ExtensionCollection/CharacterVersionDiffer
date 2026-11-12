# Char Differ

A Marinara Engine External Extension that opens a character card and one of its saved versions side by side in **meld** (or VS Code), and saves your merged result back to the card.

It's made for checking what a model really did to a card: see every change, copy back what it got wrong, keep what it improved.

## How it works

1. Open a character in Marinara's editor and find **Version History** (Metadata tab). Char Differ adds a **Meld** button there, plus a compare button on each saved version.
2. **Meld** opens the current card against the most recent saved version. The compare button on a row uses that version instead.
3. In meld, the **left** side is the saved version (read-only). The **right** side is the current card. Use meld's arrows to copy old text back over bad edits, or type into the right side. Then save (Ctrl+S) and close meld.
4. Back in Marinara, Char Differ lists the fields that will change and asks before saving. Only those fields are sent.
5. Marinara keeps the card as it was before the merge in Version History, so a merge can be undone there.

If the card changed in Marinara while meld was open, Char Differ doesn't overwrite it. It offers a new comparison of your merged text against the card as it is now. If the saved file can't be read (a section marker line was deleted or edited, or a JSON section is broken), nothing is saved and you can reopen meld with your edits.

### What the card looks like in meld

Each field is its own section, so long text diffs line by line:

```
# Char Differ: Alice — v1.0 · 2026-11-11 10:00 · manual
# Edit the right-hand file, save it (Ctrl+S), then close meld. ...
### CharDiffer: name ###
Alice
### CharDiffer: description ###
Alice is an elf who lives in a tree.

She loves riddles and hates loud noises.
### CharDiffer: alternate_greetings #1 ###
*Alice is asleep in a hammock.*
...
### CharDiffer: tags ###
Elf
Fantasy
### CharDiffer: character_book (JSON) ###
null
### CharDiffer: extensions (JSON) ###
{ ... }
```

- Keep the `### CharDiffer: … ###` lines. Lines above the first one are ignored.
- Delete an `alternate_greetings #N` section to remove that greeting, or add one (any number) to add a greeting.
- Tags go one per line. If a tag can't be written that way (a newline or spaces at the ends), tags become a JSON list instead.
- Text fields round-trip exactly, including blank lines and Windows line endings.

## Why there is a helper

A web page can't start programs. `xdg-open` is a program too, and Marinara's extension runtimes can't run processes (server extensions run in a sandbox without child processes). So a tiny local helper does it: `helper/chardiffer-helper.mjs`, plain Node, no dependencies.

- It listens on `127.0.0.1` only and needs a token on every request.
- It only accepts requests from Marinara pages on `localhost`, `127.0.0.1` or `[::1]` (any port). Use `--origin` to allow other addresses.
- Requests carry text only, never file paths or commands. The diff tool is set on the helper's own command line.
- It writes the two texts to a private folder under `$XDG_RUNTIME_DIR`, starts the tool, waits until you close the comparison, returns the right-hand file, and deletes the folder.

## Install

1. Start the helper (Node 22.18 or later):

   ```sh
   node helper/chardiffer-helper.mjs
   ```

   On first run it prints a token and saves it to `~/.config/chardiffer/token`. Leave the helper running while you diff, and press Ctrl+C to stop it. Options:

   - `--tool code` opens VS Code's diff (`code --new-window --wait --diff`) instead of meld.
   - `--tool "kdiff3 {left} {right}"` runs any other tool. It must stay running until you close the comparison.
   - `--port 7869` changes the port (7869 is the default).
   - `--origin http://192.168.1.5:7860` allows a Marinara address other than localhost.
   - `--print-token` prints the token again.

2. Skip this step if your other External Extensions already run. Otherwise, set `ENABLE_EXTERNAL_EXTENSIONS=true` in the Marinara host's `.env`, restart Marinara when convenient, and turn on **Settings > Advanced > Danger Zone > Allow third-party extension imports**.
3. **Settings > Addons > External Extensions > Import Extension Folder**. Pick the **`extension`** folder in this repository, not the repository root.
4. Open the draft, read the code, choose **Review and Run**, and approve the hash. It needs **Full page access**, because it adds buttons to Marinara's editor and calls Marinara's character API from the page.
5. In the character editor's Version History, click the gear next to **Meld** (or right-click **Meld**). Paste the token and choose **Save and test**.

Every code change disables the extension until you review and approve the new hash.

## Limitations

- Marinara merges `extensions` and `character_book` into the stored card instead of replacing them. A key you delete inside them can't be removed this way. The save dialog lists any such keys, and they stay on the card. Lists such as lorebook entries are replaced whole, so removing an entry works.
- Avatar, card comment and folders aren't part of the comparison.
- If the editor has unsaved edits, Char Differ asks you to save or discard them first.
- Char Differ finds the Version History panel by its icons, and the open character through Marinara's UI store (the same React lookup as Character Library). A Marinara update that changes either can stop the buttons from showing.
- One comparison at a time.

## Development

- `npm test` runs the unit tests: serializer round trips and the helper's token, origin, size limit and session handling.
- `npm run check` also compiles the extension the way Marinara wraps it.
- `npm run dev` serves a harness on http://localhost:5180 with a mock character API and a copy of the Version History panel. Nothing touches a real Marinara install.
- `npm run smoke` drives the harness in headless Chrome with the real helper and a fake diff tool. Set `CD_PLAYWRIGHT` to a `playwright-core` folder and `CD_CHROME` to a Chrome binary; `CD_SHOTS` saves screenshots.
