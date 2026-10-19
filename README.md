# Purple Tuxedo of Shame

A Chrome extension that makes Reddit threads worth reading, and quietly fixes
the grammar in them.

On Reddit, it hides low-effort comments, unless someone replied with
something worth reading. Then the lazy comment stays, wearing a tuxedo of
shame 🤵‍♂️, and the reply that saved the thread gets a gold star ⭐.

It also repairs the small mistakes that make text hard to read: missing
apostrophes (`dont` → `don't`), a lowercase `i`, sentences that start in
lowercase. It never touches slang, links, code or anything you are typing.
On Reddit this is on by default. On other sites it is experimental and off
until you switch it on.

Everything happens locally in your browser. Nothing is sent anywhere.

---

## How it judges a Reddit comment

Each top-level comment is weighed on two things:

- **Length.** Below a minimum (200 characters by default), it is low-effort.
- **Slop score.** A tally of missing apostrophes, lowercase `i`, slang and
  sentences that start in lowercase, scaled by the comment's length. At or above a
  threshold (15 by default), it is low-effort however long it is.

The score always judges the comment **as its author wrote it**, before any
grammar fixing, and only **what its author wrote**: quoted text and code are
left out, so quoting someone's sloppy words never counts against you.

Then:

| The comment is… | No strong reply below it | A strong reply below it |
| :--- | :--- | :--- |
| fine | left alone | left alone |
| low-effort | hidden | stays, wears 🤵‍♂️; the reply gets ⭐ |
| low-effort but popular (800+ upvotes) | stays | stays, wears 🤵‍♂️; the reply gets ⭐ |

**A hero saves the thread.** However awful the comment, and however popular,
a substantive reply keeps it visible. Popularity protects a comment from being
hidden, never from the tuxedo.

A *strong reply* is a direct reply of real substance: at least 200 characters
and 35 words, not shouting, not mostly symbols, and in sentences.

## The panel

Click the toolbar icon on a Reddit thread to see what Tux did there and to
tune it. Changes apply to the open thread at once.

- **This page:** comments judged, hidden (and why), tuxedos, heroes, comments
  spared by upvotes, paragraphs fixed.
- **Lookup failures:** comments Tux could not read and therefore left alone.
  These should be zero. If they climb, Reddit has changed its page structure;
  Tux degrades by doing nothing rather than by guessing.
- **Hiding, heroes, upvote immunity:** every threshold above.
- **What counts as slop:** the word list (each word, whether it counts as
  grammar or slang, and its points), your own additions, and the weight of
  each category.

## The Brainrot Parade 🦆

Press **Brainrot Parade** in the panel to see every judgement on the page at
once. While it marches, nothing is hidden. Instead:

- 🤡 comments Tux would hide get a stamp naming why: **TOO SHORT**, **SLOP**,
  **COLLAPSED**;
- ⭐ comments saved by a hero, 🍀 comments spared by their upvotes, and 😬
  comments that only barely passed get stamps of their own;
- clean comments dim to gray, so the verdicts stand alone in the light;
- Mr. Duck, Court Marshal, presides from the corner, slamming his gavel at
  every verdict. His eyebrow tells you what he thinks of it.

It is the quickest way to tune the thresholds, and the most fun. All sound is
synthesized in the browser, and starts after your first click on the page.
The parade adjourns itself after ten minutes and leaves the page exactly as
it found it.

## Grammar fixing, and other sites (experimental)

On Reddit, grammar fixing is on by default and can be switched off in the
panel.

On other sites it is **experimental and off by default**. Many sites rebuild
their pages in ways the fixer does not handle well yet, and it can do odd
things there. If you want to try it, open the panel and tick **Fix grammar on
other sites**; it takes effect when a page next loads. A small pill on each
page then shows what was fixed and lets you switch fixing off for that site.
While the setting is off, the fixer does nothing at all away from Reddit.

To see what it did, open the panel on that page and press **Parade the
fixes**: every paragraph the fixer changed gets a stamp. A stamp turns
see-through when you hover over it, so you can read the text underneath. The
parade leaves by itself after ten minutes.

## Reporting a bad fix

The parade is also the quickest way to report a problem, and one report can
carry many of them:

1. **Click a stamp** to open a card with everything about that paragraph:
   before and after, each correction with its rule, and where it sits on the
   page. Pick a verdict (*wrong fix*, *should have fixed*, *right but ugly*,
   *just curious*) and describe what you see in your own words.
2. **Alt-click any paragraph** to report a fix the fixer *missed*.
3. **Add to report**. Findings collect across pages until you send them.
4. In the panel, press **📮 Ship report**. One `.org` file is saved in a
   `tux-bugs` folder inside your Downloads (you can rename the folder there).

Attach that file to an [issue](https://github.com/magnusribsskog/purple-tuxedo/issues),
or hand it to your AI assistant along with this repository: it is written so
that whoever reads it needs no follow-up questions. A report contains only
the paragraphs you chose and the addresses of their pages. Read it through
before sharing.

Wherever it runs, the fixer is deliberately conservative:

- Fixes are made per paragraph, so a word after a link is not mistaken for
  the start of a sentence.
- Links, code, form fields and editable text are never changed. On Reddit,
  quoted text is left alone too: it belongs to someone else.
- Words that are only mistakes in English are left alone in other languages:
  `i` in Norwegian, `im` in German.
- Slang is never rewritten. `idk`, `rn` and `lol` carry tone; changing them
  would change what the author said.
- It works inside pages built from shadow DOM, including comment sections
  that load as you scroll.

## Install

Not yet in the Chrome Web Store.

1. Download or clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the `extension` folder.

Chrome will ask for access to all sites. That is for the experimental
grammar fixer on other sites: it needs it to read and repair text on those
pages, though it stays idle until you switch it on. It will also ask to
manage your downloads: that is only so a bug report can be saved into its own
folder instead of loose in Downloads. If you also run a separate grammar
fixing extension, disable one of them.

## Privacy

Purple Tuxedo has no server, no analytics and no network access of its own.
It reads the page you are on, changes what you see, and stores only your
settings, per-site on/off choices and any unsent bug-report findings in your
browser. A bug report leaves your computer only if you send it yourself.

## Licence

Free for personal use, hobby projects, research, education and nonprofits,
and for commercial use by organisations of up to 10 people. Larger
organisations need a commercial licence: contact **magnus.ribsskog@gmail.com**.

The full terms are in [LICENSE](LICENSE): the PolyForm Noncommercial License
1.0.0, plus the small-organisation permission stated at its top.

## Credits

Made by Magnus Ribsskog, with Florence and Sophie: persistent, multimodal AIs
running on Claude and Codex. Sophie built the first grammar fixer; Florence
finished it and brought it to Purple Tuxedo.
