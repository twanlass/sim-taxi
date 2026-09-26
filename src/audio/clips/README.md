# Drop clips here

This folder is empty on purpose. **No sample has been chosen for any event yet**, so the game is
silent and every slot in [the lab](../../../docs/audio.md) reads "no clip".

## Adding a sound

1. Put the file in this folder. `.m4a` (AAC) is what to deliver — `.ogg` is not safe on older iOS
   and this is an iPhone game — but `.mp3`, `.wav`, `.aac` and `.flac` are accepted so a `.wav` can
   be auditioned without converting first.
2. Name its **basename, without the extension** in the event's `clips` array in
   [`../events.js`](../events.js). Two or more basenames on one event is a round robin.
3. `npm run check` asserts the two agree. A name in the manifest with no file here fails it; a file
   here that no event names fails it too, because an orphan is either a typo or dead weight in the
   bundle.

Nothing else. `../clips.js` finds the file through Vite, which content-hashes it — see the note in
that file for why this must not be `public/`.

## Auditioning without committing anything

`npm run dev`, then open `/audio/` and **drag a file onto a slot**. It plays from a `blob:` URL, is
never written to the repo, and is gone on reload. That is the intended loop for trying a take.

## Licensing

Every file in this folder needs a provenance line in [`CREDITS.md`](CREDITS.md) before it is
committed — source, author, licence. `npm run check` fails on a clip that has no entry, because a
game heading for the App Store cannot carry audio whose licence nobody wrote down.

**Machine-generated audio does not belong here.** The music and effects are human-authored; that is
a deliberate decision and the reason the zero-external-assets doctrine was amended for audio at all
(see [docs/audio.md](../../../docs/audio.md)). Several CC0 packages on npm are synthesised and say so
in their own licence files — they were considered and rejected.
